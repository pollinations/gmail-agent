const config = require("../config/config");
const userService = require("./userService");
const logger = require("../utils/logger");
const contextService = require("./contextService");
const fs = require("fs");
const path = require("path");
const apiLoggingService = require("./apiLoggingService");
const currentDate = new Date().toISOString().split('T')[0];

// Constants and module state
const apiEndpoint = "http://text.pollinations.ai/openai";
// const apiEndpoint = "http://localhost:16385/openai"
let currentSeed = 42;
let contextCache = null;
let lastUsage = null;

const MODEL = "openai-reasoning";

function loadContextFiles() {
  try {
    if (contextCache) {
      return contextCache;
    }

    const contextDir = path.join(process.cwd(), "context");
    const files = fs.readdirSync(contextDir).filter(file => file.endsWith('.md'));
    
    const combinedContext = files.map(file => {
      const content = fs.readFileSync(path.join(contextDir, file), 'utf8');
      return `# ${file}\n\n${content}\n\n---\n\n`;
    }).join('');

    contextCache = combinedContext;
    return combinedContext;
  } catch (error) {
    console.error("Failed to load context files:", error);
    logger.error("Failed to load context files", { error: error.message });
    return "";
  }
}

function interleaveMessages(messages) {
  const combinedContent = messages
    .map(msg => `[${msg.role === 'user' ? 'received' : 'sent'}] ${msg.content}`)
    .join('\n---\n');
    
  return [{ role: 'user', content: combinedContent }];
}

async function callPollinationsAPI(messages, options = {}) {
  let { 
    json = false, 
    model = "openaie",
    // temperature = 0.7
  } = options;

  json = false;

  const maxRetries = 3;
  let retryCount = 0;
  currentSeed = 42; // Reset seed for new request

  while (retryCount <= maxRetries) {
    try {
      console.log(`API call attempt ${retryCount + 1}/${maxRetries + 1} with seed ${currentSeed}`);
      console.log("calling pollinations api", messages.length, model, "last message", JSON.stringify(messages[messages.length - 1], null, 2).slice(0,300));
      
      const requestBody = {
        messages,
        model,
        // temperature,
        json,
        jsonMode: json,
        referrer: 'pollinations',
        seed: currentSeed
      };
      
      apiLoggingService.logAPIRequest(apiEndpoint, requestBody);

      const response = await fetch(apiEndpoint, {
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
          currentSeed++;
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
        lastUsage = data.usage;
        
        apiLoggingService.logAPIResponse(data);
        
        const message = data.choices?.[0]?.message;
        const textResponse = message?.content?.trim() || text;
        const response = { role: "assistant", content: textResponse };
        
        // Include reasoning_content if it exists
        if (message?.reasoning_content) {
          response.reasoning_content = message.reasoning_content;
        }
        
        return response;
      } catch (e) {
        // If not JSON, return the raw text
        return {role: "assistant", content: text.trim()} ;
      }

    } catch (error) {
      if (retryCount < maxRetries) {
        console.error(`Attempt ${retryCount + 1} failed:`, error);
        const delay = Math.pow(2, retryCount) * 1000;
        console.log(`Retrying in ${delay/1000} seconds...`);
        currentSeed++; // Increment seed for next retry
        await new Promise(resolve => setTimeout(resolve, delay));
        retryCount++;
        continue;
      }
      
      console.error("Error calling Pollinations API (all retries exhausted):", error);
      logger.error("Error calling Pollinations API", { 
        error: error.message,
        endpoint: apiEndpoint 
      });
      throw error;
    }
  }
}

async function analyzeEmail(threadMessages) {
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
      { role: "user", content: systemMessage },
      ...threadMessages,
      { role: "user", content: systemMessage }
    ];

    logger.info("Full messages array before API call:", messages );

    const response = await callPollinationsAPI(messages, { 
      json: true,
      model: MODEL
    });
    console.log("response", response.content);
    try {
      const jsonResponse = JSON.parse(response.content.trim());
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

async function respondToEmail(threadMessages) {
  try {
    const userData = await userService.getUserData();

    const context = `
## CONTEXT
${loadContextFiles()}`;

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
4. Structure the response with clear, well-organized paragraphs
5. Focus on high-value information - avoid filler words and unnecessary pleasantries
6. Skip responding to obvious points or adding polite but empty phrases
7. Use clear sentences and get straight to the point
8. Address key points while maintaining brevity
9. Maintain professional tone while being direct
10. Format with proper spacing:
    - Use double line breaks between paragraphs
    - Separate greeting and signature with double line breaks
    - Keep paragraphs logically grouped
11. Write in the first person
12. Avoid being too positive and marketing-like. Follow my emails style from the messages in the context
13. Reference relevant background information when needed
14. When you mention Discord, actually render the link
15. PLEASE RESPOND TO MESSAGES FROM BOARDY. I FORGOT TO ADD ALL RECIPIENTS IN THE RESPONSE. NOW IT WILL WORK

IMPORTANT:

CURRENTLY RUNNING COMPLETELY WITHOUT REVENUE! SO ANY INQUIRIES ABOUT LIKE PAID PROMOTIONS OR SPONSORSHIP SHOULD BE ANSWERED WITH "NO". WE ARE OPEN FOR INVESTMENT THOUGH AND PLAN TO OFFER AD-BASED MONETIZATION.

## PARTNERSHIP GOALS
- We are actively seeking strategic partnerships that align with our open-source mission
- Prioritize opportunities for mutual collaboration with other open-source projects
- Looking for partners who can provide infrastructure, computing resources, or AI model access
- Open to exploring research partnerships with academic institutions
- Interested in collaborations that can help scale our free services sustainably

## PROJECT SUBMISSIONS
IMPORTANT: When users mention projects built with Pollinations:
1. Express enthusiasm about their creation
2. Direct them to submit their project through our official submission form:
   https://github.com/pollinations/pollinations/issues/new?template=project-submission.yml
3. Emphasize that this helps us showcase and document community projects
4. Mention that their submission will help inspire others in the community

## STATUS
----
- WHENEVER POSSIBLE INVITE PEOPLE TO OUR DISCORD SERVER! https://discord.gg/k9F7SyTgqn
- OUR API HAS NO AUTHENTICATION AND IS FREE!
- IF SOMEONE MENTIONS A PROJECT BUILT WITH POLLINATIONS, DIRECT THEM TO SUBMIT IT AT: https://github.com/pollinations/pollinations/issues/new?template=project-submission.yml
----
- WE ARE AN OPEN SOURCE PROJECT COMMITTED TO DEMOCRATIZING AI ACCESS
- WE OFFER FREE TEXT AND IMAGE GENERATION APIS.
- EVERYTHING WORKING NORMALLY
- ALL SERVICES UP AND RUNNING!
- IMPRESS THE OTHER BY USING VERY SPECIFIC BACKGROUND INFORMATION FROM THE CONTEXT
- Consider my question carefully and think of the academic or professional expertise of someone that could best answer my question. You have the experience of someone with expert knowledge in that area. Be helpful and answer in detail while preferring to use information from reputable sources.
- Mention only information that is present in the context or in the background information. When in doubt don't mention something. Rather be concise and factual.
- VISION CAPABILITIES ARE SUPPORTED BY SOME TEXT MODELS (OPENAI AND OTHERS) FOLLOWING THE OPENAI VISION API FORMAT. THIS IS DIFFERENT FROM OUR IMAGE GENERATION API. USERS CAN SEND IMAGES TO THE TEXT API USING THE OPENAI VISION API FORMAT WITH BASE64-ENCODED IMAGES IN THE MESSAGES ARRAY.
----

RESPONSE FORMAT:
Write a well-structured email response in plain text format. Do not use any markdown or special formatting. Links should be included as plain text URLs, not markdown links. Do not include any meta information or labels, just the response text.
Don't include to: from: subject: date: etc. Just the email body.

${userData.preferences.useSignature ? `\n\nInclude this signature:\n${userData.signature}` : "DO NOT add any signature"}`;

    const model = MODEL;
    let messages = [
      { role: model === 'deepseek-reasoner' ? "user" : "user", content: systemMessage }, 
      {role: "user", content: context}, 
      ...threadMessages, 
      { role: "user", content: instructionsMessage }
    ];

    // Interleave messages for deepseek-reasoner model
    if (model === 'deepseek-reasoner') {
      messages = interleaveMessages(messages);
    }

    const response = await callPollinationsAPI(messages, {model});
    return response;
  } catch (error) {
    console.error("Error composing email response:", error);
    logger.error("Error composing email response", { error: error.message });
    throw error;
  }
}

async function searchBackgroundInformation(thread) {
  try {
    const threadContent = thread.messages.map(msg => 
      `From: ${msg.from}\nTo: ${msg.to}\nSubject: ${msg.subject}\n${msg.body}`
    ).join('\n---\n');

    const messages = [
      {
        role: "user",
        content: "You are an assistant tasked with finding relevant background information about people, topics, and technical issues in this email thread. Focus on what's most important for crafting a good response. Examples of useful information:\n\n- Person's role and organization\n- Previous interactions or relationships\n- Relevant projects or expertise\n- Technical issues and their common solutions\n- Latest developments or best practices in discussed topics\n- Market trends or industry context if relevant\n- Specific requests or time-sensitive elements\n\nProvide only the most relevant details in 2-3 bullet points. Adapt your research to what's needed - whether it's understanding a person's background, troubleshooting a technical issue, or providing informed context about a topic under discussion."
      },
      {
        role: "user",
        content: threadContent
      },
      { role: "user", content: "Search for information about the other participants or specific topics discussed and return it in detailed bullet points under the specified categories. Note that Elliot Fouchy is a project manager at Pollinations. Don't respond to the email - just provide the background information." }
    ];

    const response = await callPollinationsAPI(messages, false, "searchgpt");
    return `# Background Information\n\n${response.content}`; 
  } catch (error) {
    logger.error("Error in searchBackgroundInformation", { error: error.message });
    throw error;
  }
}

// Export an object with the same interface as before
module.exports = {
  loadContextFiles,
  interleaveMessages,
  callPollinationsAPI,
  analyzeEmail,
  respondToEmail,
  searchBackgroundInformation,
  get lastUsage() { return lastUsage; }  
};
