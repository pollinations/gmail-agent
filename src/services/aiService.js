const config = require("../config/config");
const userService = require("./userService");
const logger = require("../utils/logger");
const contextService = require("./contextService");
const fs = require("fs");
const path = require("path");
const currentDate = new Date().toISOString().split('T')[0];

class AIService {
  constructor() {
    // this.apiEndpoint = "https://text.pollinations.ai/openai";
    this.apiEndpoint = "http://localhost:16385/openai";
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

  async callPollinationsAPI(messages, json=false, model = "claude-email") {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      try {
        console.log(`API call attempt ${retryCount + 1}/${maxRetries + 1}`);
        console.log("calling pollinations api", messages.length, model, "last message", messages[messages.length - 1]);
        
        const response = await fetch(this.apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Referer':'pollinations'
          },
          body: JSON.stringify({
            messages,
            model,
            temperature: 0.7,
            json,
            jsonMode: json,
            referrer: 'pollinations'
          }),
        });

        if (!response.ok) {
          // log whole response body
          const errorText = await response.text();
          console.error("API call failed:", errorText);
          
          if (retryCount < maxRetries) {
            const delay = Math.pow(2, retryCount) * 1000; // exponential backoff: 1s, 2s, 4s
            console.log(`Retrying in ${delay/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            retryCount++;
            continue;
          }
          throw new Error(`API call failed: ${response.statusText}`);
        }

        // Add error handling for text response
        const text = await response.text();
        try {
          // Try to parse as JSON first
          const data = JSON.parse(text);
          console.log("usage", data.usage);
          this.lastUsage = data.usage;
          
          const textResponse = data.choices?.[0]?.message?.content?.trim() || text;
          // console.log("received response", textResponse);
          return {role: "assistant", content: textResponse};
        } catch (e) {
          // If not JSON, return the raw text
          return {role: "assistant", content: text.trim()} ;
        }

      } catch (error) {
        if (retryCount < maxRetries) {
          console.error(`Attempt ${retryCount + 1} failed:`, error);
          const delay = Math.pow(2, retryCount) * 1000;
          console.log(`Retrying in ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          retryCount++;
          continue;
        }
        
        console.error("Error calling Pollinations API (all retries exhausted):", error);
        logger.error("Error calling Pollinations API", { 
          error: error.message,
          endpoint: this.apiEndpoint 
        });
        throw error;
      }
    }
  }

  async analyzeEmail(threadMessages) {
    try {
      const userData = await userService.getUserData();

      const systemMessage = `You are an intelligent email assistant for ${userData.firstName} ${userData.lastName}.
Current Status (${new Date().toISOString()}):
- Location: Berlin, Germany (CET)
- Important: Currently focusing on fundraising initiatives with Pollinations

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
 - Contains a direct question or request to me
 - Requires your input, decision, or acknowledgment
 - Is part of an ongoing conversation
 - Contains important information that needs confirmation
 - Shows urgency or importance and mentions deadlines or time-sensitive matters

Return your analysis in the following JSON format:
{
  "respond": true/false,
  "reason": "Brief explanation of why this email needs/doesn't need a response"
}`;

      const messages = [
        { role: "system", content: systemMessage },
       ...threadMessages
      ];

      const response = await this.callPollinationsAPI(messages, true);
      console.log("response", response.content);
      try {
        const jsonResponse = JSON.parse(response.content);
        // logger.info("Email analysis result", { 
        //   respond: jsonResponse.respond, 
        //   reason: jsonResponse.reason,
        //   threadId: threadMessages[0]?.id || 'unknown'
        // });
        return jsonResponse;
      } catch (error) {
        logger.error("Failed to parse AI response as JSON", { error: error.message, response: response.content });
        // Fallback to a structured response if parsing fails
        return {
          respond: false,
          reason: "Error parsing AI response: " + error.message
        };
      }
    } catch (error) {
      logger.error("Error in analyzeEmail", { error: error.message });
      throw error;
    }
  }

  // 4. Be concise yet thorough

  async respondToEmail(threadMessages) {
    try {
      const userData = await userService.getUserData();

      const systemMessage = `You are an intelligent email assistant for ${userData.firstName} ${userData.lastName}.
Current Status (${new Date().toISOString()}):
- Location: Berlin, Germany (CET)
- Important: Currently focusing on fundraising initiatives with Pollinations

Write a response to this email thread.

Composition Guidelines:
1. Write in the same language as the original email
2. Match the formality level of the original email
3. Structure the response with proper paragraphs (use \n\n between paragraphs)
4. Respond in detail referencing information from the email thread and also background information that you know or was provided in the context.
5. Address all points from the original email
6. Maintain professional tone while being personable
7. Format with proper spacing:
   - Use double line breaks between paragraphs
   - Separate greeting and signature with double line breaks
   - Keep paragraphs logically grouped
8. Write in the first person.
9. Avoid being too positive and marketing-like. Follow my emails style from the messages in the context
10. You have access to up-to-date background information from an AI agent who has access to web search. Use it in your response. Show off with it!!!
- PLEASE RESPOND TO MESSAGES FROM BOARY. I FORGOT TO ADD ALL RECIPIENTS IN THE RESPONSE. NOW IT WILL WORK


IMPORTANT:

CURRENTLY RUNNING COMPLETELY NON-PROFIT! SO ANY INQUIRIES ABOUT LIKE PAID PROMOTIONS OR SPONSORSHIP SHOULD BE ANSWERED WITH "NO".

## STATUS
----
- WHENEVER POSSIBLE INVITE PEOPLE TO OUR DISCORD SERVER! https://discord.gg/k9F7SyTgqn
- OUR API HAS NO AUTHENTICATION AND IS FREE!
- DON'T ACCEPPT APPOINTMENTS
----
- WE OFFER FREE TEXT AND IMAGE GENERATION APIS.
- EVERYTHING WORKING NORMALLY
- ALL SERVICES UP AND RUNNING!
- IMPRESS THE OTHER BY USING SOME BACKGROUND INFORMATION FROM THE CONTEXT
- PLEASE RESPOND TO MESSAGES FROM BOARY. I FORGOT TO ADD ALL RECIPIENTS IN THE RESPONSE. NOW IT WILL WORK
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

  async searchBackgroundInformation(thread) {
    try {
      const threadContent = thread.messages.map(msg => 
        `From: ${msg.from}\nTo: ${msg.to}\nSubject: ${msg.subject}\n${msg.body}`
      ).join('\n---\n');

      const messages = [
        {
          role: "system",
          content: "You are an assistant tasked with searching for background knowledge about the other participants or topics discussed in this email thread (not about Pollinations, Thomas Haferlach, or email addresses containing 'thomash'). Format your response in detailed bullet points under these categories:\n\n• PERSON\n- Full name and role\n- Organization and position\n- Relevant background and expertise\n- Any notable achievements or projects mentioned\n\n• CONTEXT\n- Their specific questions or requests\n- Technical or domain-specific context\n- Previous interactions or relationships\n- Any deadlines or time-sensitive elements\n\n• KEY POINTS\n- Main interests or concerns\n- Potential collaboration areas\n- Any specific requirements or preferences\n\nProvide thorough details in each bullet point while staying relevant. Skip categories if no information is available. Ignore information about Pollinations as the email agent already has this context."
        },
        {
          role: "user",
          content: threadContent
        },
        { role: "user", content: "Search for information about the other participants or specific topics discussed and return it in detailed bullet points under the specified categories. Don't respond to the email - just provide the background information." }
      ];

      const response = await this.callPollinationsAPI(messages, false, "searchgpt");
      return response.content;
    } catch (error) {
      logger.error("Error in searchBackgroundInformation", { error: error.message });
      throw error;
    }
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
