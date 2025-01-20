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
    // this.apiEndpoint = "http://localhost:16385/openai";
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

  async callPollinationsAPI(messages, model = "claude-email") {
    try {
      console.log("calling pollinations api", messages.length, model, "last message", messages[messages.length - 1]);
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
        // log whole response body
        console.error("API call failed:", await response.text());
        throw new Error(`API call failed: ${response.statusText}`);
      }

      // Add error handling for text response
      const text = await response.text();
      try {
        // Try to parse as JSON first
        const data = JSON.parse(text);
        console.log("usage", data.usage);
        this.lastUsage = data.usage;
        
        // Check if prompt tokens exceed 80,000 and remove first 10% of messages if needed
        if (data.usage.prompt_tokens > 80000 && messages.length > 1) {
          const messagesToRemove = Math.ceil(messages.length * 0.1); // Calculate 10% of messages
          messages.splice(0, messagesToRemove); // Remove first 10% of messages
          console.log(`Removed ${messagesToRemove} messages due to high token count`);
        }
        
        const textResponse = data.choices?.[0]?.message?.content?.trim() || text;
        // console.log("received response", textResponse);
        return {role: "assistant", content: textResponse};
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

  async analyzeEmail(threadMessages) {
    try {
      const userData = await userService.getUserData();
      // const combinedContext = this.loadContextFiles();

      const systemMessage = `You are an intelligent email assistant for ${userData.firstName} ${userData.lastName}.
Analyze this email thread and determine if it needs a response.

Classification Guidelines:
1. Return FALSE if the email thread is clearly promotional or automated, such as:
   - Marketing newsletters or promotional offers
   - Automated notifications from services (e.g., "Your order has shipped")
   - Social media notifications
   - System-generated reports
   - Bulk promotional emails
   - "No-reply" automated messages
   - Subscription confirmations or updates

2. Return TRUE if ANY of these conditions are met:
   - The email is from a real person (not automated)
   - Contains a direct question or request
   - Requires your input, decision, or acknowledgment
   - Is part of an ongoing conversation
   - Contains important information that needs confirmation
   - Is a personal or business communication
   - Shows urgency or importance
   - Mentions deadlines or time-sensitive matters

When in doubt, return TRUE to avoid missing important communications.

RESPONSE FORMAT:
Return ONLY the word TRUE or FALSE`;

      const messages = [{ "role": "system", "content": systemMessage }, ...threadMessages];
      const response = await this.callPollinationsAPI(messages);
      const shouldReply = response.content.trim().toUpperCase() === 'TRUE';
      console.log("shouldReply", shouldReply);
      return shouldReply;
    } catch (error) {
      console.error("Error analyzing email:", error);
      logger.error("Error analyzing email", { error: error.message });
      throw error;
    }
  }

  async respondToEmail(threadMessages) {
    try {
      const userData = await userService.getUserData();

      const systemMessage = `You are an intelligent email assistant for ${userData.firstName} ${userData.lastName}.
Write a response to this email thread.

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
   - Keep paragraphs logically grouped
8. Write in the first person.
9. Be concise and to the point. Avoid being too positive and marketing-like.

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

## CONTEXT
${this.loadContextFiles()}

RESPONSE FORMAT:
Write a well-structured email response. Do not include any meta information or labels, just the response text.
Don't include to: from: subject: date: etc. Just the email body.

${userData.preferences.useSignature ? `\n\nInclude this signature:\n${userData.signature}` : "DO NOT add any signature"}`;

      const messages = [{ role: "system", content: systemMessage }, ...threadMessages];
      const response = await this.callPollinationsAPI(messages);
      return response.content.trim();
    } catch (error) {
      console.error("Error composing email response:", error);
      logger.error("Error composing email response", { error: error.message });
      throw error;
    }
  }

  async generateForcedResponse(threadMessages) {
    return this.respondToEmail(threadMessages);
  }

  async refineResponse(threadMessages, userModification) {
    // Add the user modification as the last message in the thread
    const messagesWithModification = [
      ...threadMessages,
      { role: "user", content: `Please revise the previous response. ${userModification}` }
    ];
    return this.respondToEmail(messagesWithModification);
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
}

module.exports = new AIService();
