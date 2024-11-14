const { google } = require("googleapis");
const fs = require("fs/promises");
const path = require("path");
const config = require("../config/config");
const logger = require("../utils/logger");
const userService = require("../services/userService");

async function initializeGmail() {
  try {
    const credentials = JSON.parse(
      await fs.readFile(config.gmail.credentials, "utf8")
    );

    const oauth2Client = new google.auth.OAuth2(
      credentials.web.client_id,
      credentials.web.client_secret,
      credentials.web.redirect_uris[0]
    );

    // Read token
    const tokenPath = path.resolve(process.cwd(), "token.json");
    const token = JSON.parse(await fs.readFile(tokenPath, "utf8"));
    oauth2Client.setCredentials(token);

    return google.gmail({ version: "v1", auth: oauth2Client });
  } catch (error) {
    logger.error("Failed to initialize Gmail", { error: error.message });
    throw error;
  }
}

async function getEmailThread(gmail, threadId) {
  try {
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
    });

    return thread.data;
  } catch (error) {
    logger.error(`Failed to fetch thread ${threadId}`, { error: error.message });
    return null;
  }
}

function extractEmailContent(message) {
  const headers = message.payload.headers;
  const from = headers.find((h) => h.name === "From")?.value || "Unknown";
  const subject = headers.find((h) => h.name === "Subject")?.value || "No Subject";
  const date = headers.find((h) => h.name === "Date")?.value || "Unknown Date";

  let body = "";
  
  function getBody(part) {
    if (part.body.data) {
      return Buffer.from(part.body.data, "base64").toString();
    }
    if (part.parts) {
      return part.parts.map(getBody).join("\n");
    }
    return "";
  }

  body = getBody(message.payload);

  // Clean the body and preserve line breaks
  body = body
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/(\r\n|\n|\r)/g, "\n") // Normalize line endings
    .replace(/\n{2,}/g, "\n\n") // Ensure double line breaks for paragraphs
    .trim();

  return { from, subject, date, body };
}

function isMyEmail(from, myEmails) {
  // Normalize the email addresses for comparison
  const normalizedFrom = from.toLowerCase();
  return myEmails.some(email => normalizedFrom.includes(email.toLowerCase()));
}

async function formatThreadAsMarkdown(thread, myEmails) {
  const messages = thread.messages;
  if (!messages || messages.length === 0) return null;

  // Find the original email (first non-me message)
  const originalMessage = messages.find(message => {
    const from = message.payload.headers.find(h => h.name === "From")?.value || "";
    return !isMyEmail(from, myEmails);
  });

  if (!originalMessage) return null;

  let markdown = [];
  const firstMessage = extractEmailContent(originalMessage);
  
  markdown.push(`## ${firstMessage.subject}`);
  markdown.push(`**From:** ${firstMessage.from}`);
  markdown.push(`**Date:** ${firstMessage.date}`);
  markdown.push("\n### Original Email");
  markdown.push(firstMessage.body);
  
  // Get my responses (messages from me after the original email)
  const myResponses = messages
    .filter(message => {
      const from = message.payload.headers.find(h => h.name === "From")?.value || "";
      return isMyEmail(from, myEmails);
    });

  if (myResponses.length > 0) {
    const lastResponse = extractEmailContent(myResponses[myResponses.length - 1]);
    markdown.push("\n### My Response");
    markdown.push(lastResponse.body);
  } else {
    // Skip threads without my response
    return null;
  }

  markdown.push("\n---\n");
  return markdown.join("\n");
}

async function exportResponses(limit = 20) {
  try {
    logger.info(`Starting email response export with limit: ${limit}`);
    const gmail = await initializeGmail();
    const userData = await userService.getUserData();
    const myEmails = userData.emails;
    logger.info(`Using emails: ${myEmails.join(", ")}`);

    // Get all threads where I've responded
    const response = await gmail.users.threads.list({
      userId: "me",
      q: myEmails.map(email => `from:${email}`).join(" OR "),
      maxResults: limit * 2, // Fetch more since we'll filter some out
    });

    if (!response.data.threads) {
      logger.info("No email threads found");
      return;
    }

    let markdown = `# Email Response History (Last ${limit} Responses)\n\n`;
    let processedCount = 0;
    let threadsWithResponses = 0;

    for (const thread of response.data.threads) {
      if (threadsWithResponses >= limit) break;

      const threadData = await getEmailThread(gmail, thread.id);
      if (threadData) {
        const threadMarkdown = await formatThreadAsMarkdown(threadData, myEmails);
        if (threadMarkdown) {
          markdown += threadMarkdown;
          threadsWithResponses++;
        }
      }

      processedCount++;
      // Log progress every 5 threads
      if (processedCount % 5 === 0) {
        logger.info(`Processed ${processedCount} threads, found ${threadsWithResponses} with responses...`);
      }
    }

    // Create exports directory if it doesn't exist
    const exportDir = path.join(process.cwd(), "exports");
    await fs.mkdir(exportDir, { recursive: true });

    // Save with timestamp and limit info
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(exportDir, `email-responses-${limit}-${timestamp}.md`);
    await fs.writeFile(filePath, markdown);

    logger.info(`Successfully exported ${threadsWithResponses} email threads with responses to ${filePath}`);
    return filePath;
  } catch (error) {
    logger.error("Failed to export responses", { error: error.message });
    throw error;
  }
}

// Run the export if called directly
if (require.main === module) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const limit = args.length > 0 ? parseInt(args[0], 10) : 20;

  if (isNaN(limit) || limit <= 0) {
    console.error("Please provide a valid positive number for the limit");
    process.exit(1);
  }

  exportResponses(limit).catch((error) => {
    console.error("Export failed:", error);
    process.exit(1);
  });
}

module.exports = exportResponses; 