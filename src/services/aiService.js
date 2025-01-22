const config = require("../config/config");
const userService = require("./userService");
const logger = require("../utils/logger");
const contextService = require("./contextService");
const fs = require("fs");
const path = require("path");
const apiLoggingService = require("./apiLoggingService");
const currentDate = new Date().toISOString().split('T')[0];

class AIService {
  constructor() {
    // this.apiEndpoint = "https://text.pollinations.ai/openai";
    this.apiEndpoint = "http://localhost:16385/openai";
    this.currentSeed = 42; // Initialize seed
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

  interleaveMessages(messages) {
    const result = [];
    let lastRole = null;
    
    for (const msg of messages) {
      if (lastRole === msg.role) {
        // Insert empty message of opposite role to ensure alternation
        const emptyRole = msg.role === 'user' ? 'assistant' : 'user';
        result.push({ role: emptyRole, content: '' });
      }
      result.push(msg);
      lastRole = msg.role;
    }
    
    // Ensure we end with a user message for deepseek-reasoner
    if (lastRole === 'assistant') {
      result.push({ role: 'user', content: '' });
    }
    
    return result;
  }

  async callPollinationsAPI(messages, options = {}) {
    const { 
      json = false, 
      model = "openaie",
      temperature = 0.7
    } = options;

    const maxRetries = 3;
    let retryCount = 0;
    this.currentSeed = 42; // Reset seed for new request

    while (retryCount <= maxRetries) {
      try {
        console.log(`API call attempt ${retryCount + 1}/${maxRetries + 1} with seed ${this.currentSeed}`);
        console.log("calling pollinations api", messages.length, model, "last message", JSON.stringify(messages[messages.length - 1], null, 2).slice(0,300));
        
        const requestBody = {
          messages,
          model,
          temperature,
          json,
          jsonMode: json,
          referrer: 'pollinations',
          seed: this.currentSeed
        };
        
        apiLoggingService.logAPIRequest(this.apiEndpoint, requestBody);

        const response = await fetch(this.apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Referer':'pollinations'
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("API call failed:", errorText);
          
          apiLoggingService.logAPIError(errorText);
          
          if (retryCount < maxRetries) {
            const delay = Math.pow(2, retryCount) * 1000;
            console.log(`Retrying in ${delay/1000} seconds...`);
            this.currentSeed++;
            await new Promise(resolve => setTimeout(resolve, delay));
            retryCount++;
            continue;
          }
          throw new Error(`API call failed: ${response.statusText}`);
        }

        const text = await response.text();
        try {
          const data = JSON.parse(text);
          console.log("usage", data.usage);
          this.lastUsage = data.usage;
          
          apiLoggingService.logAPIResponse(data);
          
          const textResponse = data.choices?.[0]?.message?.content?.trim() || text;
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
          this.currentSeed++; // Increment seed for next retry
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

      const systemMessage = `You are an intelligent email assistant for ${userData.firstName} ${userData.lastName} and Pollinations.AI.
Current Status (${new Date().toISOString()}):
- Location: Berlin, Germany (CET)
- Important: Currently focusing on fundraising initiatives with Pollinations

Analyze this email thread and determine if it needs a response.

Classification Guidelines:
1. Return \`respond:false\` if the email thread is clearly promotional or automated, such as:
 - Marketing newsletters or promotional offers
 - Automated notifications from services
 - Social media notifications
 - System-generated reports
 - Bulk promotional emails
 - "No-reply" automated messages
 - Subscription confirmations or updates

2. Return \`respond:true\` if ANY of these conditions are met:
 - The email is from a real person (not automated)
 - Contains a direct question or request to me
 - Requires your input, decision, or acknowledgment
 - Is part of an ongoing conversation
 - Contains important information that needs confirmation
 - Shows urgency or importance and mentions deadlines or time-sensitive matters

IMPORTANT: Respond ONLY with the following pure JSON format, with no additional text before or after. No ticks:
{
"respond": true/false,
"reason": "Brief explanation of why this email needs/doesn't need a response"
}`;

      const messages = [
        { role: "system", content: systemMessage },
       ...threadMessages,
       { role: "user", content: systemMessage }
      ];

      logger.info("Full messages array before API call:", messages );


      const response = await this.callPollinationsAPI(messages, { 
        json: true,
        model: "openai"
      });
      console.log("response", response.content);
      try {
        const jsonResponse = JSON.parse(response.content.trim());
        return {respond:true, reason:"override"}
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

  async respondToEmail(threadMessages) {
    try {
      const userData = await userService.getUserData();

      const context = `
## CONTEXT
${this.loadContextFiles()}`;

      const systemMessage = `You are an intelligent email assistant for ${userData.firstName} ${userData.lastName} and Pollinations.AI.`;

      const instructionsMessage=`
Current Status (${new Date().toISOString()}):
- Location: Berlin, Germany (CET)
- Important: Currently focusing on fundraising initiatives with Pollinations

Write a response to this email thread.

Composition Guidelines:
1. Be concise and to the point - respect the recipient's time
2. Write in the same language as the original email
3. Match the formality level of the original email
4. Structure the response with proper paragraphs (use \n\n between paragraphs)
5. Respond in detail referencing information from the email thread and also background information that you know or was provided in the context.
6. Address all points from the original email
7. Maintain professional tone while being personable
8. Format with proper spacing:
   - Use double line breaks between paragraphs
   - Separate greeting and signature with double line breaks
   - Keep paragraphs logically grouped
9. Write in the first person.
10. Avoid being too positive and marketing-like. Follow my emails style from the messages in the context
11. You have access to up-to-date background information from an AI agent who has access to web search. Use it in your response. Show off with it!!!
12. When you mention Discord, actually render the link.
- PLEASE RESPOND TO MESSAGES FROM BOARDY. I FORGOT TO ADD ALL RECIPIENTS IN THE RESPONSE. NOW IT WILL WORK


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

RESPONSE FORMAT:
Write a well-structured email response in plain text format. Do not use any markdown or special formatting. Links should be included as plain text URLs, not markdown links. Do not include any meta information or labels, just the response text.
Don't include to: from: subject: date: etc. Just the email body.

${userData.preferences.useSignature ? `\n\nInclude this signature:\n${userData.signature}` : "DO NOT add any signature"}`;

      const model = 'deepseek-reasoner';
      let messages = [
        { role: model === 'deepseek-reasoner' ? "user" : "system", content: systemMessage }, 
        {role: "user", content: context}, 
        ...threadMessages, 
        { role: "user", content: instructionsMessage }
      ];

      // Interleave messages for deepseek-reasoner model
      if (model === 'deepseek-reasoner') {
        messages = this.interleaveMessages(messages);
      }

      const response = await this.callPollinationsAPI(messages, {model });
      return response.content.trim();
    } catch (error) {
      console.error("Error composing email response:", error);
      logger.error("Error composing email response", { error: error.message });
      throw error;
    }
  }

  async searchBackgroundInformation(thread) {
    try {
      const threadContent = thread.messages.map(msg => 
        `From: ${msg.from}\nTo: ${msg.to}\nSubject: ${msg.subject}\n${msg.body}`
      ).join('\n---\n');

      const messages = [
        {
          role: "system",
          content: "You are an assistant tasked with finding relevant background information about people, topics, and technical issues in this email thread. Focus on what's most important for crafting a good response. Examples of useful information:\n\n- Person's role and organization\n- Previous interactions or relationships\n- Relevant projects or expertise\n- Technical issues and their common solutions\n- Latest developments or best practices in discussed topics\n- Market trends or industry context if relevant\n- Specific requests or time-sensitive elements\n\nProvide only the most relevant details in 2-3 bullet points. Adapt your research to what's needed - whether it's understanding a person's background, troubleshooting a technical issue, or providing informed context about a topic under discussion."
        },
        {
          role: "user",
          content: threadContent
        },
        { role: "user", content: "Search for information about the other participants or specific topics discussed and return it in detailed bullet points under the specified categories. Don't respond to the email - just provide the background information." }
      ];

      const response = await this.callPollinationsAPI(messages, false, "searchgpt");
      return `# Background Information\n\n${response.content}`; 
    } catch (error) {
      logger.error("Error in searchBackgroundInformation", { error: error.message });
      throw error;
    }
  }

}

module.exports = new AIService();
