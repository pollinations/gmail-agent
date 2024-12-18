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
      console.error("Failed to load context files:", error);
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
      console.error("Error calling Pollinations API:", error);
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

  async analyzeEmail(email) {
    try {
      const userData = await userService.getUserData();
      const combinedContext = this.loadContextFiles();

      // Check if email is marked as important
      const isImportant = email.headers?.some(
        header => header.name === "Importance" && header.value.toLowerCase() === "high"
      ) || email.headers?.some(
        header => header.name === "X-Priority" && ["1", "2"].includes(header.value)
      );

      const systemMessage = `You are an intelligent email assistant for ${userData.firstName} ${userData.lastName}.
Analyze emails and determine if they need a response or can be archived.

Classification Guidelines:
1. ARCHIVE ONLY IF the email is clearly promotional or automated, such as:
   - Marketing newsletters or promotional offers
   - Automated notifications from services (e.g., "Your order has shipped")
   - Social media notifications
   - System-generated reports
   - Bulk promotional emails
   - "No-reply" automated messages
   - Subscription confirmations or updates

2. RESPOND if ANY of these conditions are met:
   - The email is from a real person (not automated)
   - Contains a direct question or request
   - Requires your input, decision, or acknowledgment
   - Is part of an ongoing conversation
   - Contains important information that needs confirmation
   - Is a personal or business communication
   - Shows urgency or importance
   - Mentions deadlines or time-sensitive matters

When in doubt, choose RESPOND over ARCHIVE to avoid missing important communications.

IMPORTANT:

CURRENTLY RUNNING COMPLETELY NON-PROFIT! SO ANY INQUIRIES ABOUT LIKE PAID PROMOTIONS OR SPONSORSHIP SHOULD BE ANSWERED WITH "NO".

## STATUS
----
- WHENEVER POSSIBLE INVITE PEOPLE TO OUR DISCORD SERVER! https://discord.gg/k9F7SyTgqn
- OUR API HAS NO AUTHENTICATION AND IS FREE!
- DON'T ACCEPPT APPOINTMENTS
----
- WE OFFER FREE TEXT AND IMAGE GENERATION APIS.
- 14.11.24
- EVERYTHING WORKING NORMALLY
- ALL SERVICES UP AND RUNNING!
- IF CAROLINE IS IN THE THHREAD DONT RESPOND TO HER BUT THE OTHER PERSON
----

# RESPONSE FORMAT
Required Response Format:
Action: [RESPOND or ARCHIVE]
Reason: [Brief explanation of why this action was chosen]`;

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
      const analysis = this.parseAIResponse(response.content);

      // Force RESPOND action for important emails
      if (isImportant && analysis.action === "ARCHIVE") {
        console.info(`Forcing RESPOND action for important email: ${email.subject}`);
        logger.info(`Forcing RESPOND action for important email`, {
          emailId: email.id,
          subject: email.subject,
          originalAction: analysis.action
        });
        
        analysis.action = "RESPOND";
        analysis.reason = "Email marked as important - requires response";
      }

      return analysis;
    } catch (error) {
      console.error("Error analyzing email:", error);
      logger.error("Error analyzing email", { error: error.message });
      throw error;
    }
  }

  async generateForcedResponse(email) {
    return this.composeEmailResponse(email);
  }

  async refineResponse(originalEmail, originalResponse, userModification) {
    return this.composeEmailResponse(originalEmail, {}, userModification);
  }

  parseAIResponse(response) {
    try {
      const lines = response.split("\n").filter((line) => line.trim() !== "");
      let action = "";
      let reason = "";

      for (const line of lines) {
        if (line.startsWith("Action:")) {
          action = line.substring("Action:".length).trim();
        } else if (line.startsWith("Reason:")) {
          reason = line.substring("Reason:".length).trim();
        }
      }

      // Validate and handle missing draft response
      if (!action || !reason) {
        throw new Error("Invalid AI response format - missing action or reason");
      }

      action = action.toUpperCase();


      return {
        action,
        reason,
      };
    } catch (error) {
      console.error("Error parsing AI response:", error, response);
      logger.error("Error parsing AI response:", {
        error: error.message,
        rawResponse: response
      });
      // Return a default response
      return {
        action: "RESPOND",
        reason: "Error parsing AI response",
      };
    }
  }


  async composeEmailResponse(email, context = {}) {
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
      console.error("Error composing email response:", error);
      logger.error("Error composing email response", { error: error.message });
      throw error;
    }
  }
}

module.exports = new AIService();
