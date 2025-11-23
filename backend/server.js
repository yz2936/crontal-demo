
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize Gemini
// WARNING: process.env.API_KEY must be set in a .env file
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const MODEL_FAST = "gemini-2.5-flash";

// File upload setup
const upload = multer({ dest: "uploads/" });

// In-memory store for demo purposes
const rfqStore = {}; 
const quoteStore = {};

// Helper to convert file to generative part
function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: fs.readFileSync(path).toString("base64"),
      mimeType,
    },
  };
}

// 1. Parse/Edit Endpoint
app.post("/api/buyer/parse", upload.array("files"), async (req, res) => {
  try {
    const { text, projectName, currentLineItems, lang } = req.body;
    const files = req.files || [];
    
    // Parse current items if sent as string
    let currentItems = [];
    if (currentLineItems) {
        try { currentItems = JSON.parse(currentLineItems); } catch (e) {}
    }

    const isEditMode = currentItems.length > 0;
    const language = lang || 'en';

    const systemInstruction = `
    You are Crontal's expert procurement AI. Your role is to extract or modify structured RFQ data.

    MODE: ${isEditMode ? "EDITING EXISTING LIST" : "CREATING NEW LIST"}

    YOUR TASKS:
    1. Analyze the text input and any files.
    2. ${isEditMode 
        ? `The user wants to MODIFY the "Current Line Items" provided.
           - IF user says "Delete line X" or "Remove item X": Exclude it from the returned list.
           - IF user says "Change quantity/grade/size...": Update the specific item.
           - IF user provides new specs: Append them as new items.
           - ALWAYS return the COMPLETE, valid list of items after applying changes.
           - Preserve existing IDs for unchanged items.` 
        : `Extract all line items from scratch.`}
    
    3. DIMENSION HANDLING:
       - You MUST split dimensions into: 
         * OD (Outer Diameter)
         * WT (Wall Thickness)
         * Length
       - Normalize units to: 'mm', 'm', 'in', 'ft', 'pcs'.
    
    4. COMMERCIAL TERMS:
       - Extract Destination, Incoterm, Payment Terms if mentioned.

    OUTPUT FORMAT:
    - Return ONLY valid JSON matching the schema.
    - If inferring text, use language: "${language}".
    `;

    const parts = [];
    
    let promptText = `USER REQUEST:\n"""${text}"""\n\nProject Name Context: ${projectName || "N/A"}\n`;
    if (isEditMode) {
        promptText += `\n\n[CURRENT LINE ITEMS DATA - APPLY CHANGES TO THIS LIST]:\n${JSON.stringify(currentItems, null, 2)}\n`;
    }

    parts.push({ text: promptText });

    // Process uploaded files
    for (const file of files) {
        parts.push(fileToGenerativePart(file.path, file.mimetype));
        // Clean up temp file
        fs.unlinkSync(file.path);
    }

    // Call Gemini
    const response = await ai.models.generateContent({
        model: MODEL_FAST,
        contents: { parts },
        config: {
            systemInstruction: systemInstruction,
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    project_name: { type: "STRING", nullable: true },
                    commercial: {
                        type: "OBJECT",
                        properties: {
                            destination: { type: "STRING", nullable: true },
                            incoterm: { type: "STRING", nullable: true },
                            payment_terms: { type: "STRING", nullable: true },
                            other_requirements: { type: "STRING", nullable: true }
                        }
                    },
                    line_items: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                item_id: { type: "STRING" },
                                description: { type: "STRING" },
                                product_type: { type: "STRING", nullable: true },
                                material_grade: { type: "STRING", nullable: true },
                                size: {
                                    type: "OBJECT",
                                    properties: {
                                        od_val: { type: "NUMBER", nullable: true },
                                        od_unit: { type: "STRING", nullable: true },
                                        wt_val: { type: "NUMBER", nullable: true },
                                        wt_unit: { type: "STRING", nullable: true },
                                        len_val: { type: "NUMBER", nullable: true },
                                        len_unit: { type: "STRING", nullable: true }
                                    }
                                },
                                quantity: { type: "NUMBER", nullable: true },
                                uom: { type: "STRING", nullable: true }
                            }
                        }
                    }
                }
            }
        }
    });

    const parsedData = JSON.parse(response.text || "{}");

    // Map to internal structure
    const items = (parsedData.line_items || []).map((li, idx) => {
        return {
            item_id: li.item_id || `L${Date.now()}-${idx}`,
            line: idx + 1,
            description: li.description || "",
            material_grade: li.material_grade || "",
            size: {
                outer_diameter: { value: li.size?.od_val, unit: li.size?.od_unit },
                wall_thickness: { value: li.size?.wt_val, unit: li.size?.wt_unit },
                length: { value: li.size?.len_val, unit: li.size?.len_unit }
            },
            quantity: li.quantity,
            uom: li.uom
        };
    });

    const rfqId = req.body.rfqId || `RFQ-${Date.now().toString().slice(-4)}`;
    
    const result = {
        rfq_id: rfqId,
        project_name: parsedData.project_name,
        commercial: {
            destination: parsedData.commercial?.destination || "",
            incoterm: parsedData.commercial?.incoterm || "",
            paymentTerm: parsedData.commercial?.payment_terms || "",
            otherRequirements: parsedData.commercial?.other_requirements || ""
        },
        line_items: items
    };
    
    // Store/Update it
    rfqStore[result.rfq_id] = result;

    res.json(result);

  } catch (error) {
    console.error("Parse Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Clarify/Chat Endpoint
app.post("/api/buyer/clarify", async (req, res) => {
    try {
        const { rfq, userMessage, lang } = req.body;
        const systemInstruction = `
        You are Crontal's RFQ assistant.
        Goal: Confirm the user's action (edit/delete/add) and summarize the current state of the RFQ.
        Input Context: The table has ALREADY been updated by the parsing engine.
        Your job is just to generate a polite confirmation message in "${lang || 'en'}".
        Example: "I've removed line 3 as requested." or "I've added the new specs."
        Keep it short.
        `;

        const rfqSummary = JSON.stringify({
            item_count: rfq.line_items.length,
            items_sample: rfq.line_items.slice(0, 3).map(i => `${i.quantity} ${i.uom} ${i.description}`)
        });

        const response = await ai.models.generateContent({
            model: MODEL_FAST,
            contents: `Updated RFQ State: ${rfqSummary}\n\nUser Action: ${userMessage}`,
            config: { systemInstruction }
        });

        res.json({ message: response.text });
    } catch (error) {
        res.json({ message: "I've updated the table. Please review the details." });
    }
});

// 3. Get RFQ
app.get("/api/rfq/:id", (req, res) => {
    const rfq = rfqStore[req.params.id];
    if(rfq) res.json(rfq);
    else res.status(404).json({error: "Not found"});
});

// 4. Submit Quote
app.post("/api/rfqs/:id/quotes", (req, res) => {
    const id = req.params.id;
    const quote = req.body;
    if(!quoteStore[id]) quoteStore[id] = [];
    quoteStore[id].push(quote);
    res.json({success: true});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
