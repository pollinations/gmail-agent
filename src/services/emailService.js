const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");
const config = require("../config/config");
const logger = require("../utils/logger");
const userService = require("./userService");
const fs = require("fs");
const path = require("path");
const open = require("open");
const { OpenAIEmbeddings } = require("@langchain/openai");
const { encode, decode } = require("gpt-3-encoder");
const { default: PQueue } = require('p-queue');

class EmailService {
  constructor() {
    this.gmail = null;
    this.currentEmailBatch = []; // Store current batch of unread emails
    this.processedEmails = new Set(); // Keep track of processed emails
    this.queue = new PQueue({ concurrency: 1 });
    this.userEmail = null; // Store user's email from Gmail profile
  }

  async initialize() {
    try {
      // Validate OpenAI API key first
      if (!config.openai.apiKey) {
        throw new Error("OpenAI API key is not configured");
      }

      // Initialize Gmail first
      await this.initializeGmail();

      try {
        // Initialize OpenAI embeddings
        this.embeddings = new OpenAIEmbeddings({
          openAIApiKey: config.openai.apiKey,
        });
        logger.info("OpenAI embeddings initialized successfully");
      } catch (embeddingsError) {
        logger.error("Failed to initialize OpenAI embeddings", {
          error: embeddingsError.message,
          stack: embeddingsError.stack,
        });
        // Continue without embeddings - will fall back to basic similarity
        this.embeddings = null;
      }

      logger.info("Email service initialized successfully");
    } catch (error) {
      console.error("Failed to initialize email service:", error);
      logger.error("Failed to initialize email service", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  async initializeGmail() {
    try {
      // Validate credentials file exists
      if (!fs.existsSync(config.gmail.credentials)) {
        throw new Error(
          `Gmail credentials file not found at: ${config.gmail.credentials}`
        );
      }

      // Get absolute path for credentials
      const tokenPath = path.resolve(process.cwd(), "token.json");
      logger.info(`Token will be saved to: ${tokenPath}`);

      // Read credentials file
      const credentials = JSON.parse(
        fs.readFileSync(config.gmail.credentials, "utf8")
      );

      const oauth2Client = new google.auth.OAuth2(
        credentials.web.client_id,
        credentials.web.client_secret,
        credentials.web.redirect_uris[0]
      );

      // Check if we have a stored token
      if (fs.existsSync(tokenPath)) {
        const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
        oauth2Client.setCredentials(token);
      } else {
        // Generate authentication URL
        const authUrl = oauth2Client.generateAuthUrl({
          access_type: "offline",
          scope: config.gmail.scopes,
        });

        // Open the URL in the default browser
        logger.info("Opening browser for authentication...");
        await open(authUrl);

        // Prompt for the code
        const code = await this.waitForAuthCode();

        // Get tokens
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Save token
        fs.writeFileSync(tokenPath, JSON.stringify(tokens));
        logger.info("Token saved successfully");
      }

      this.gmail = google.gmail({ version: "v1", auth: oauth2Client });

      // Get and store user's email from profile
      const profile = await this.gmail.users.getProfile({ userId: "me" });
      this.userEmail = profile.data.emailAddress;
      logger.info("Gmail service initialized successfully", { userEmail: this.userEmail });

      // Test the connection
      await this.gmail.users.getProfile({ userId: "me" });
      logger.info("Gmail service initialized successfully");
    } catch (error) {
      console.error("Failed to initialize Gmail service:", error);
      logger.error("Failed to initialize Gmail service", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  async waitForAuthCode() {
    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question("Enter the authorization code from the browser: ", (code) => {
        rl.close();
        resolve(code);
      });
    });
  }

  // async fetchUnreadEmails() {
  //   try {
  //     const response = await this.gmail.users.messages.list({
  //       userId: "me",
  //       q: "is:unread category:primary",
  //       maxResults: 500,
  //     });

  //     if (!response.data.messages) {
  //       logger.info("No unread messages found in Primary category");
  //       return [];
  //     }

  //     // Get user data to check email addresses
  //     const userData = await userService.getUserData();
  //     const myEmails = userData.emails || [];

  //     // Process each message and filter out threads where we have the last reply
  //     const processedEmails = await Promise.all(
  //       response.data.messages
  //         .filter((message) => !this.processedEmails.has(message.id))
  //         .map(async (message) => {
  //           try {
  //             // Get the thread instead of just the message
  //             const thread = await this.gmail.users.threads.get({
  //               userId: "me",
  //               id: message.threadId,
  //             });

  //             const messages = thread.data.messages || [];
  //             if (messages.length === 0) return null;

  //             // Get the last message in the thread
  //             const lastMessage = messages[messages.length - 1];
  //             const lastMessageFrom = lastMessage.payload.headers.find(
  //               (h) => h.name === "From"
  //             )?.value || "";

  //             // Skip if the last message is from us
  //             if (myEmails.some((email) =>
  //               lastMessageFrom.toLowerCase().includes(email.toLowerCase())
  //             )) {
  //               logger.info(`Skipping thread ${message.threadId} - last message is from us`);
  //               return null;
  //             }

  //             // Only process if this message is the last unread message in the thread
  //             const isLastUnreadMessage = messages
  //               .slice(messages.indexOf(lastMessage))
  //               .every((m) => m.labelIds?.includes("UNREAD"));

  //             if (!isLastUnreadMessage) {
  //               logger.info(`Skipping message ${message.id} - not the last unread message in thread`);
  //               return null;
  //             }

  //             // Get the message details
  //             const email = await this.gmail.users.messages.get({
  //               userId: "me",
  //               id: lastMessage.id, // Use the last message ID instead
  //             });

  //             return this.parseEmail(email.data);
  //           } catch (error) {
  //             console.error(`Error processing message ${message.id}:`, error);
  //             logger.error(`Error processing message ${message.id}`, {
  //               error: error.message,
  //               threadId: message.threadId,
  //             });
  //             return null;
  //           }
  //         })
  //     );

  //     // Filter out null results and store in currentEmailBatch
  //     this.currentEmailBatch = processedEmails.filter((email) => email !== null);

  //     logger.info(`Fetched ${this.currentEmailBatch.length} new unread emails from Primary category`);
  //     return this.currentEmailBatch;
  //   } catch (error) {
  //     console.error("Failed to fetch unread emails:", error);
  //     logger.error("Failed to fetch unread emails", { error: error.message });
  //     throw error;
  //   }
  // }

  prepareTextForEmbedding(email) {
    try {
      if (!email?.subject || !email?.body) return null;

      // Combine subject and first part of body (weighted towards subject)
      const text = `${email.subject}\n${email.subject}\n${email.body}`.slice(
        0,
        8000
      );

      // Basic cleaning
      const cleanText = text
        .replace(/\s+/g, " ")
        .replace(/[^\w\s.,?!]/g, "")
        .trim();

      return cleanText;
    } catch (error) {
      logger.error("Error preparing text for embedding", {
        error: error.message,
        emailId: email?.id,
      });
      return null;
    }
  }

  hasUnsubscribeLink(body) {
    const unsubscribeKeywords = [
      "unsubscribe",
      "opt-out",
      "opt out",
      "remove from",
      "désinscription",
      "désabonner",
    ];

    const lowerBody = body.toLowerCase();
    return unsubscribeKeywords.some((keyword) => lowerBody.includes(keyword));
  }

  hasSimilarFormat(body1, body2) {
    // Compare basic structure (presence of links, formatting, etc.)
    const getFormatSignature = (body) => {
      return {
        hasLinks: body.includes("http") || body.includes("www"),
        hasUnsubscribe: this.hasUnsubscribeLink(body),
        lineCount: body.split("\n").length,
        hasHtmlTags: body.includes("<") && body.includes(">"),
      };
    };

    const sig1 = getFormatSignature(body1);
    const sig2 = getFormatSignature(body2);

    return JSON.stringify(sig1) === JSON.stringify(sig2);
  }

  cleanHtml(text) {
    return (
      text
        // Remove HTML tags
        .replace(/<[^>]*>/g, "")
        // Replace HTML entities
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, "/")
        .replace(/&apos;/g, "'")
        // Remove any remaining HTML entities
        .replace(/&[^;]+;/g, "")
    );
  }

  cleanEmailBody(text) {
    return (
      text
        // Remove HTML
        .replace(/<[^>]*>/g, "")
        // Remove email signatures (common patterns)
        .replace(/^--\s*$/m, "")
        .replace(/^Sent from.*$/m, "")
        .replace(/^Get Outlook.*$/m, "")
        // Remove quoted text
        .replace(/^>.*$/gm, "")
        .replace(/^On.*wrote:$/gm, "")
        // Remove horizontal whitespace while preserving newlines
        .replace(/[^\S\n]+/g, " ")
        // Remove empty lines
        .replace(/^\s*[\r\n]/gm, "\n")
        // Normalize line endings
        .replace(/\r\n/g, "\n")
        // Remove lines with just dashes or underscores (often used as separators)
        .replace(/^[-_]{2,}$/gm, "")
        // Remove common footer patterns
        .replace(/^Disclaimer:.*$/m, "")
        .replace(/^Confidentiality notice:.*$/m, "")
        // Clean up multiple newlines (keep max 2)
        .replace(/\n{3,}/g, "\n\n")
        // Trim whitespace
        .trim()
    );
  }

  parseEmail(emailData) {
    try {
      const headers = emailData.payload.headers;
      const from = headers.find((h) => h.name === "From")?.value || "";
      const to = headers.find((h) => h.name === "To")?.value || "";
      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const date = headers.find((h) => h.name === "Date")?.value || "";
      const messageId = headers.find((h) => h.name === "Message-ID")?.value || "";

      // Extract body content
      const body = this.extractText(emailData.payload);

      return {
        id: emailData.id,
        threadId: emailData.threadId,
        from,
        to,
        subject,
        date,
        messageId,
        body,
        snippet: emailData.snippet,
        internalDate: emailData.internalDate,
        headers: emailData.payload.headers
      };
    } catch (error) {
      logger.error("Error parsing email", { error: error.message });
      return null;
    }
  }

  async archiveEmail(emailId) {
    try {
      // Only remove UNREAD label
      await this.gmail.users.messages.modify({
        userId: "me",
        id: emailId,
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      });

      // Add to processed emails set
      this.processedEmails.add(emailId);

      // Remove from current batch if present
      this.currentEmailBatch = this.currentEmailBatch.filter(
        (email) => email.id !== emailId
      );

      logger.info(`Successfully marked email ${emailId} as read`);
      return true;
    } catch (error) {
      logger.error(`Failed to mark email ${emailId} as read`, {
        error: error.message,
      });
      throw error;
    }
  }

  async bulkArchive(emailIds) {
    const results = [];
    for (const emailId of emailIds) {
      try {
        await this.archiveEmail(emailId);
        results.push({ emailId, success: true });
      } catch (error) {
        results.push({ emailId, success: false, error: error.message });
      }
    }

    // Force refresh the current batch after bulk operation
    this.currentEmailBatch = this.currentEmailBatch.filter(
      (email) => !emailIds.includes(email.id)
    );

    return results;
  }

  // Method declarations - no 'function' keyword needed
  normalizeEmail(email) {
    return email?.toLowerCase().trim() || "";
  }

  extractEmail(address) {
    const match = address?.match(/<(.+?)>/) || address?.match(/([^\s]+@[^\s]+)/);
    return match ? match[1].toLowerCase() : this.normalizeEmail(address);
  }

  getUniqueRecipients(from, to, cc) {
    // Convert all addresses to Set for deduplication
    const toSet = new Set([
      this.extractEmail(from), // Original sender goes to To
    ]);

    // Process original To recipients
    if (to) {
      to.split(",").forEach((addr) => {
        const email = this.extractEmail(addr);
        if (email && email !== this.extractEmail(from)) {
          // Don't add if it's the sender
          toSet.add(email);
        }
      });
    }

    // Process CC recipients
    const ccSet = new Set();
    if (cc) {
      cc.split(",").forEach((addr) => {
        const email = this.extractEmail(addr);
        if (email && !toSet.has(email)) {
          // Only add to CC if not in To
          ccSet.add(addr.trim());
        }
      });
    }

    // Add pollinations.ai to CC if not already in To
    if (!toSet.has("hello@pollinations.ai")) {
      ccSet.add("hello@pollinations.ai");
    }

    return {
      to: Array.from(toSet).join(", "),
      cc: Array.from(ccSet).join(", "),
    };
  }


  // Method to mark an email as processed without archiving
  markAsProcessed(emailId) {
    this.processedEmails.add(emailId);
    this.currentEmailBatch = this.currentEmailBatch.filter(
      (email) => email.id !== emailId
    );
  }

  // Method to clear processed emails (useful for testing or reset)
  clearProcessedEmails() {
    this.processedEmails.clear();
    logger.info("Cleared processed emails list");
  }

  // Add this utility function at class level
  getEmailSignature(email) {
    const tokens = encode(`${email.subject} ${email.from}`);
    return tokens.slice(0, 100).join(","); // Create a simple signature from first 100 tokens
  }

  async markAsRead(emailId) {
    try {
      // Only remove UNREAD label
      await this.gmail.users.messages.modify({
        userId: "me",
        id: emailId,
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      });

      // Add to processed emails set
      this.processedEmails.add(emailId);

      // Remove from current batch if present
      this.currentEmailBatch = this.currentEmailBatch.filter(
        (email) => email.id !== emailId
      );

      logger.info(`Successfully marked email ${emailId} as read`);
      return true;
    } catch (error) {
      logger.error(`Failed to mark email ${emailId} as read`, {
        error: error.message,
      });
      throw error;
    }
  }

  async createDraft(threadId, message) {
    try {
      // Add default subject if missing
      if (!message.subject) {
        message.subject = "Re: Pollinations AI Discussion";
      }

      // Validate required fields
      const requiredFields = ['to', 'subject', 'body'];
      const missingFields = requiredFields.filter(field => !message[field]);
      if (missingFields.length > 0) {
        throw new Error(`Missing required fields for draft: ${missingFields.join(', ')}`);
      }

      // Ensure message body has proper line breaks
      const formattedBody = message.body
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      let messageId = message.messageId;
      let references = message.references;

      // Try to fetch thread data, but continue even if it fails
      try {
        const thread = await this.gmail.users.threads.get({
          userId: 'me',
          id: threadId
        });
        
        const lastMessage = thread.data.messages[thread.data.messages.length - 1];
        const headers = lastMessage.payload.headers;
        
        // Use thread data for messageId/references if not provided
        messageId = messageId || headers.find(h => h.name === 'Message-ID')?.value;
        references = references || messageId;
      } catch (error) {
        logger.warn(`Failed to fetch thread data for ${threadId}, continuing with draft creation`, { error: error.message });
      }

      logger.info("Creating draft message", {
        to: message.to,
        subject: message.subject,
        threadId
      });

      const draft = await this.gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            threadId,
            raw: Buffer.from(
              `From: ${this.userEmail}\n` +
              `To: ${message.to}\n` +
              `Subject: ${message.subject}\n` +
              (messageId ? `Message-ID: ${messageId}\n` : '') +
              (references ? `References: ${references}\n` : '') +
              'Content-Type: text/plain; charset=utf-8\n' +
              '\n' +
              formattedBody
            ).toString('base64')
          }
        }
      });

      return draft.data;
    } catch (error) {
      logger.error(`Failed to create draft for thread ${threadId}`, {
        error: error.message,
        threadId,
        to: message.to,
        subject: message.subject
      });
      throw error;
    }
  }

  async markMessageAsRead(messageId) {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['UNREAD']
        }
      });
      logger.info('Message marked as read', { messageId });
    } catch (error) {
      logger.error('Error marking message as read', { error: error.message, messageId });
      throw error;
    }
  }

  async listMessages(maxResults = 100, query = "category:primary") {
    try {
      let allMessages = [];
      let pageToken;

      do {
        const response = await this.gmail.users.messages.list({
          maxResults: Math.min(maxResults - allMessages.length, 100), // Gmail API max is 100 per request
          userId: "me",
          q: query,
          pageToken: pageToken
        });

        if (!response.data.messages) {
          break;
        }

        allMessages = allMessages.concat(response.data.messages);
        pageToken = response.data.nextPageToken;
      } while (pageToken && allMessages.length < maxResults);
      console.log("got ", allMessages.length, "messages");
      return allMessages;
    } catch (error) {
      logger.error('Error listing messages', { error: error.message });
      throw error;
    }
  }

  async fetchEmailThreads(maxResults = 100) {
    try {
      console.log("asking for", maxResults, "threads");
      
      const messages = await this.listMessages(maxResults);
      
      if (!messages.length) {
        logger.info("No messages found in Primary category");
        return [];
      }

      // Process each thread
      const processedThreads = await Promise.all(
        messages.map(async (message, index) => this.queue.add(async () => {
          try {
            // Get the full thread
            const thread = await this.gmail.users.threads.get({
              userId: "me",
              id: message.threadId,
            });

            if (!thread.data.messages || thread.data.messages.length === 0) {
              return null;
            }

            // Parse all messages in the thread
            const threadMessages = await Promise.all(
              thread.data.messages.map(async (msg) => {
                const email = await this.gmail.users.messages.get({
                  userId: "me",
                  id: msg.id,
                });
                return this.parseEmail(email.data);
              })
            );

            console.log(`Progress: ${index + 1}/${messages.length} From: ${threadMessages[0].from} Subject: ${threadMessages[0].subject}.`);
            // Get subject from the first message

            // Return thread info along with all messages
            return {
              threadId: thread.data.id,
              messages: threadMessages.slice(-5), // last 2
              snippet: thread.data.snippet,
              historyId: thread.data.historyId
            };
            
          } catch (error) {
            console.error(`Error processing thread ${message.threadId}:`, error);
            logger.error(`Error processing thread ${message.threadId}`, {
              error: error.message,
              stack: error.stack
            });
            return null;
          }
        }))
      );

      // Filter out null results
      const validThreads = processedThreads.filter(thread => thread !== null);
      
      logger.info(`Successfully processed ${validThreads.length} email threads`);
      return validThreads;
    } catch (error) {
      console.error("Failed to fetch email threads:", error);
      logger.error("Failed to fetch email threads", { 
        error: error.message,
        stack: error.stack 
      });
      throw error;
    }
  }

  async downloadThreadContent(threadId) {
    try {
      // Get the full thread
      const thread = await this.gmail.users.threads.get({
        userId: "me",
        id: threadId,
      });

      if (!thread.data.messages || thread.data.messages.length === 0) {
        return null;
      }

      // Get user data to check email addresses
      const userData = await userService.getUserData();
      const myEmails = userData.emails || [];

      // Process all messages in the thread
      const messages = await Promise.all(
        thread.data.messages.map(async (message) => {
          const email = await this.gmail.users.messages.get({
            userId: "me",
            id: message.id,
          });
          const parsed = this.parseEmail(email.data);
          return {
            ...parsed,
            labelIds: email.data.labelIds || [],
            senderIsMe: myEmails.some(email => 
              parsed.from.toLowerCase().includes(email.toLowerCase())
            )
          };
        })
      );

      // Get subject from the first message
      const subject = messages[0]?.subject || "";

      // Check if last message is unread - indicates we might need to reply
      const lastMessage = messages[messages.length - 1];
      const needsReply = lastMessage?.labelIds?.includes('UNREAD') || false;

      // Check if any message is from the user
      const hasMyMessage = messages.some(msg => 
        myEmails.some(email => 
          msg.from.toLowerCase().includes(email.toLowerCase())
        )
      );

      return {
        threadId,
        subject,
        messages,
        needsReply,
        hasMyMessage
      };
    } catch (error) {
      console.error(`Error downloading thread ${threadId}:`, error);
      logger.error(`Error downloading thread ${threadId}`, {
        error: error.message,
      });
      return null;
    }
  }

  extractText(part) {
    let text = "";

    if (part.mimeType && part.mimeType.startsWith("text/") && part.body?.data) {
      const decodedText = Buffer.from(part.body.data, "base64").toString();
      text += part.mimeType === "text/html" ? this.cleanHtml(decodedText) : decodedText;
    }

    if (part.parts) {
      for (const subPart of part.parts) {
        text += this.extractText(subPart);
        if (subPart.mimeType === "text/plain") break;
      }
    }

    if (part.mimeType === "message/rfc822" && part.body.attachmentId) {
      const attachedMessage = part.parts?.[0];
      if (attachedMessage) {
        text += this.extractText(attachedMessage);
      }
    }

    return this.cleanEmailBody(text);
  }

  async applyToArchiveLabel(emailId) {
    try {
      // Get the correct label ID
      const labelId = await this.ensureToArchiveLabelExists();

      // Apply ToArchive label and remove UNREAD label
      await this.gmail.users.messages.modify({
        userId: "me",
        id: emailId,
        requestBody: {
          addLabelIds: [labelId],
          removeLabelIds: ["UNREAD"],
        },
      });

      // Add to processed emails set
      this.processedEmails.add(emailId);

      // Remove from current batch if present
      this.currentEmailBatch = this.currentEmailBatch.filter(
        (email) => email.id !== emailId
      );

      logger.info(`Successfully applied ToArchive label to email ${emailId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to apply ToArchive label to email ${emailId}`, {
        error: error.message,
      });
      console.error(error);
      throw error;
    }
  }

  // Update the ensureToArchiveLabelExists method
  async ensureToArchiveLabelExists() {
    try {
      // Get all labels
      const response = await this.gmail.users.labels.list({
        userId: "me",
      });

      // Check if toarchive label exists (case sensitive)
      const toArchiveLabel = response.data.labels.find(
        (label) => label.name === "toarchive"
      );

      if (!toArchiveLabel) {
        logger.error("toarchive label not found - please create it manually in Gmail");
        throw new Error("toarchive label not found");
      }

      logger.info("Found existing toarchive label");
      return toArchiveLabel.id;
    } catch (error) {
      logger.error("Error ensuring toarchive label exists", {
        error: error.message,
      });
      throw error;
    }
  }

  // Update bulkArchive to use the new label
  async bulkApplyToArchiveLabel(emailIds) {
    const results = [];
    for (const emailId of emailIds) {
      try {
        await this.applyToArchiveLabel(emailId);
        results.push({ emailId, success: true });
      } catch (error) {
        results.push({ emailId, success: false, error: error.message });
      }
    }

    // Force refresh the current batch after bulk operation
    this.currentEmailBatch = this.currentEmailBatch.filter(
      (email) => !emailIds.includes(email.id)
    );

    return results;
  }

  getAllThreadParticipants(messages) {
    const participants = new Set();

    messages.forEach(message => {
      const addParticipant = (address) => {
        if (!address) return;
        const email = this.extractEmail(address);
        if (email && email !== this.userEmail) {
          participants.add(address.trim()); // Keep the full address including name if present
        }
      };

      // Add all participants from from/to/cc/reply-to fields
      addParticipant(message.from);
      if (message.to) message.to.split(',').forEach(addParticipant);
      if (message.cc) message.cc.split(',').forEach(addParticipant);
      
      // Add Reply-To if present in headers
      const replyTo = message.headers?.find(h => h.name.toLowerCase() === 'reply-to')?.value;
      if (replyTo) replyTo.split(',').forEach(addParticipant);
    });

    logger.info(`Found ${participants.size} unique participants`);
    return Array.from(participants);
  }
}

module.exports = new EmailService();
