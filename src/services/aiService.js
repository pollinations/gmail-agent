const config = require("../config/config");
const userService = require("./userService");
const logger = require("../utils/logger");
const contextService = require("./contextService");
const fs = require("fs");
const path = require("path");
const currentDate = new Date().toISOString().split('T')[0];

class AIService {
  constructor() {
    this.apiEndpoint = "https://text.pollinations.ai/openai";
  }

  loadContextFiles() {
    try {
      if (this.contextCache) {
        return this.contextCache;
      }

      const contextDir = path.join(process.cwd(), "context");
      const files = fs.readdirSync(contextDir).filter(file => file.endsWith('.md'));
      
      const combinedContext = files.map(file => {
        const content = fs.readFileSync(path.join(contextDir, file), 'utf8');
        return `# ${file}\n\n${content}\n\n---\n\n`;
      }).join('');

      // console.log("context", combinedContext);

      this.contextCache = combinedContext;
      return combinedContext;
    } catch (error) {
      logger.error("Failed to load context files", { error: error.message });
      return "";
    }
  }

  async callPollinationsAPI(messages, model = "openai") {
    try {
      console.log("calling pollinations api", messages, model);
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          model,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        throw new Error(`API call failed: ${response.statusText}`);
      }

      // Add error handling for text response
      const text = await response.text();
      console.log("received response", text);
      try {
        // Try to parse as JSON first
        const data = JSON.parse(text);
        return {role: "assistant", content: data.choices?.[0]?.message?.content?.trim() || text};
      } catch (e) {
        // If not JSON, return the raw text
        return {role: "assistant", content: text.trim()} ;
      }

    } catch (error) {
      logger.error("Error calling Pollinations API", { 
        error: error.message,
        endpoint: this.apiEndpoint 
      });
      throw error;
    }
  }

  async summarizeThread(email) {
    const systemMessage = `Analyze and summarize this email thread, with special emphasis on the most recent messages. 
Provide a concise summary (max 3 lines) that:
1. Identifies the most recent development or latest request (HIGHEST PRIORITY)
2. Provides essential context from earlier messages (if relevant)
3. Highlights any pending actions or time-sensitive matters

Format your summary to clearly distinguish between:
- LATEST: [Most recent email's key points]
- CONTEXT: [Brief relevant history if needed]`;

    const messages = [
      { role: "system", content: systemMessage },
      { role: "user", content: `Subject: ${email.subject}\nFrom: ${email.from}\n# Content\n${email.body}` }
    ];

    return this.callPollinationsAPI(messages);
  }

  async analyzeEmail(email, isFollowUp = false) {
    try {
      const userData = await userService.getUserData();
      const combinedContext = this.loadContextFiles();

      const systemMessage = `You are an intelligent email assistant for ${userData.firstName} ${userData.lastName}.
Analyze emails and determine if they need a response or can be archived.

Classification Guidelines:
1. ALWAYS ARCHIVE if the email is:
   - An automated notification or alert
   - A newsletter or marketing email
   - A system-generated message
   - A notification from a service
   - A delivery status or tracking update
   - A calendar invitation or update
   - A subscription confirmation
   - An automated receipt or invoice
   - A social media notification
   - A promotional offer
   - A "no-reply" sender address

2. Consider RESPOND only if ALL these conditions are met:
   - The email is from a real person (not automated)
   - It contains a direct question or request requiring action
   - It's a personal or business communication needing human interaction
   - It's not part of an automated workflow
   - It requires your specific input or decision

Required Response Format:
Action: [RESPOND or ARCHIVE]
Reason: [Brief explanation of why this action was chosen]
Draft Response: [If Action is RESPOND, provide a draft response]`;

      const userMessage = `Available Historical Context:
${combinedContext}

Current Date: ${currentDate}

Analyze this email:
Subject: ${email.subject || ""}
From: ${email.from || ""}
Date: ${new Date(parseInt(email.internalDate)).toLocaleString()}
# Content 
${email.body || ""}`;

      const messages = [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ];

      const response = await this.callPollinationsAPI(messages);
      return this.parseAIResponse(response.content);
    } catch (error) {
      logger.error("Error analyzing email", { error: error.message });
      throw error;
    }
  }

  async generateForcedResponse(email) {
    return this.composeEmailResponse(email);
  }

  async refineResponse(originalEmail, originalResponse, userModification, editHistory = []) {
    return this.composeEmailResponse(originalEmail, {}, userModification);
  }

  parseAIResponse(response) {
    try {
      const lines = response.split("\n").filter((line) => line.trim() !== "");
      let action = "", reason = "", draftResponse = "";
      let inDraftResponse = false;

      for (const line of lines) {
        if (line.startsWith("Action:")) {
          action = "RESPOND"; //line.substring("Action:".length).trim();
        } else if (line.startsWith("Reason:")) {
          reason = line.substring("Reason:".length).trim();
        } else if (line.startsWith("Draft Response:")) {
          inDraftResponse = true;
          draftResponse = line.substring("Draft Response:".length).trim();
        } else if (inDraftResponse) {
          draftResponse += "\n" + line;
        }
      }

      // Validate and handle missing draft response
      if (!action || !reason) {
        throw new Error("Invalid AI response format - missing action or reason");
      }

      action = action.toUpperCase();

      // If action is RESPOND but no draft response, generate a default one
      if (action === "RESPOND" && !draftResponse.trim()) {
        logger.warn("Missing draft response for RESPOND action, using default");
        draftResponse = "I received your email and will review it shortly.";
      }

      // Normalize paragraph breaks only if there's a draft response
      if (draftResponse) {
        draftResponse = draftResponse
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/([^\n])\n([^\n])/g, '$1\n$2')
          .replace(/([^.\n])\n\n([A-Z])/g, '$1\n\n$2')
          .trim();
      }

      return {
        action,
        reason,
        draftResponse: action === "RESPOND" ? draftResponse : null,
      };
    } catch (error) {
      logger.error("Error parsing AI response:", {
        error: error.message,
        rawResponse: response
      });
      console.error(error, response);
      // Return a default response
      return {
        action: "RESPOND",
        reason: "Error parsing AI response",
        draftResponse: "I received your email and will review it shortly.",
      };
    }
  }

  // Add new method for prompt-based editing
  async editResponseWithPrompt(email, originalResponse, editingPrompt) {
    return this.composeEmailResponse(email, {}, editingPrompt);
  }

  async composeEmailResponse(email, context = {}, editingPrompt = null) {
    try {
      const userData = await userService.getUserData();
      const combinedContext = this.loadContextFiles();

      const systemMessage = `You are an intelligent email assistant for ${userData.firstName} ${userData.lastName}.

Available Historical Context:
${combinedContext}

Current Date: ${currentDate}

Email to Respond to:
Subject: ${email.subject}
From: ${email.from}
Date: ${new Date(parseInt(email.internalDate)).toLocaleString()}
# Content 
${email.body}

${editingPrompt ? `Editing Instructions:\n${editingPrompt}\n\nModify the response according to these instructions while maintaining appropriate tone and format.` : "Compose a new response that appropriately addresses this email."}

Composition Guidelines:
1. Write in the same language as the original email
2. Match the formality level of the original email
3. Structure the response with proper paragraphs (use \n\n between paragraphs)
4. Be concise yet thorough
5. Address all points from the original email
6. Maintain professional tone while being personable
7. Format with proper spacing:
   - Use double line breaks between paragraphs
   - Separate greeting and signature with double line breaks
   - Keep paragraphs logically grouped`;

      const userMessage = `Signature Instruction: ${userData.preferences.useSignature ? `Include this signature:\n${userData.signature}` : "DO NOT add any signature"}

Write a well-structured response with proper paragraph formatting.`;

      const messages = [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ];

      const response = await this.callPollinationsAPI(messages);
      return response.content.trim();
    } catch (error) {
      logger.error("Error composing email response", { error: error.message });
      throw error;
    }
  }
}

module.exports = new AIService();
