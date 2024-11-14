const { google } = require("googleapis");
const fs = require("fs/promises");
const path = require("path");
const config = require("../config/config");
const logger = require("../utils/logger");

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

  // Clean the body
  body = body
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();

  return { from, subject, date, body };
}

function formatThreadAsMarkdown(thread) {
  const messages = thread.messages;
  if (!messages || messages.length === 0) return null;

  let markdown = [];
  
  // Get the first message (original email)
  const firstMessage = extractEmailContent(messages[0]);
  
  markdown.push(`## ${firstMessage.subject}`);
  markdown.push(`**From:** ${firstMessage.from}`);
  markdown.push(`**Date:** ${firstMessage.date}`);
  markdown.push("\n### Original Email");
  markdown.push(firstMessage.body);
  
  // Get my responses (last message in thread if it's from me)
  if (messages.length > 1) {
    const lastMessage = extractEmailContent(messages[messages.length - 1]);
    if (lastMessage.from.includes("me") || lastMessage.from.includes(config.gmail.userEmail)) {
      markdown.push("\n### My Response");
      markdown.push(lastMessage.body);
    }
  }

  markdown.push("\n---\n");
  return markdown.join("\n");
}

async function exportResponses() {
  try {
    logger.info("Starting email response export");
    const gmail = await initializeGmail();

    // Get all threads where I've responded
    const response = await gmail.users.threads.list({
      userId: "me",
      q: "in:sent",
      maxResults: 500, // Adjust as needed
    });

    if (!response.data.threads) {
      logger.info("No email threads found");
      return;
    }

    let markdown = "# Email Response History\n\n";
    let processedCount = 0;

    for (const thread of response.data.threads) {
      const threadData = await getEmailThread(gmail, thread.id);
      if (threadData) {
        const threadMarkdown = formatThreadAsMarkdown(threadData);
        if (threadMarkdown) {
          markdown += threadMarkdown;
          processedCount++;
        }
      }

      // Log progress every 10 threads
      if (processedCount % 10 === 0) {
        logger.info(`Processed ${processedCount} threads...`);
      }
    }

    // Create exports directory if it doesn't exist
    const exportDir = path.join(process.cwd(), "exports");
    await fs.mkdir(exportDir, { recursive: true });

    // Save with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(exportDir, `email-responses-${timestamp}.md`);
    await fs.writeFile(filePath, markdown);

    logger.info(`Successfully exported ${processedCount} email threads to ${filePath}`);
  } catch (error) {
    logger.error("Failed to export responses", { error: error.message });
    throw error;
  }
}

// Run the export if called directly
if (require.main === module) {
  exportResponses().catch((error) => {
    console.error("Export failed:", error);
    process.exit(1);
  });
}

module.exports = exportResponses; 