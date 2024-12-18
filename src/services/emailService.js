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

class EmailService {
  constructor() {
    this.gmail = null;
    this.currentEmailBatch = []; // Store current batch of unread emails
    this.processedEmails = new Set(); // Keep track of processed emails
    this.embeddings = null;
    this.emailEmbeddings = new Map(); // Cache for email embeddings
    this.similarityThreshold = 0.85;
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

  async fetchUnreadEmails() {
    try {
      const response = await this.gmail.users.messages.list({
        userId: "me",
        q: "is:unread category:primary",
        maxResults: 500,
      });

      if (!response.data.messages) {
        logger.info("No unread messages found in Primary category");
        return [];
      }

      // Get user data to check email addresses
      const userData = await userService.getUserData();
      const myEmails = userData.emails || [];

      // Process each message and filter out threads where we have the last reply
      const processedEmails = await Promise.all(
        response.data.messages
          .filter((message) => !this.processedEmails.has(message.id))
          .map(async (message) => {
            try {
              // Get the thread instead of just the message
              const thread = await this.gmail.users.threads.get({
                userId: "me",
                id: message.threadId,
              });

              const messages = thread.data.messages || [];
              if (messages.length === 0) return null;

              // Get the last message in the thread
              const lastMessage = messages[messages.length - 1];
              const lastMessageFrom = lastMessage.payload.headers.find(
                h => h.name === "From"
              )?.value || "";

              // Skip if the last message is from us
              if (myEmails.some(email => 
                lastMessageFrom.toLowerCase().includes(email.toLowerCase())
              )) {
                logger.info(`Skipping thread ${message.threadId} - last message is from us`);
                return null;
              }

              // Only process if this message is the last unread message in the thread
              const isLastUnreadMessage = messages
                .slice(messages.indexOf(lastMessage))
                .every(m => m.labelIds?.includes('UNREAD'));

              if (!isLastUnreadMessage) {
                logger.info(`Skipping message ${message.id} - not the last unread message in thread`);
                return null;
              }

              // Get the message details
              const email = await this.gmail.users.messages.get({
                userId: "me",
                id: lastMessage.id, // Use the last message ID instead
              });

              return this.parseEmail(email.data);
            } catch (error) {
              console.error(`Error processing message ${message.id}:`, error);
              logger.error(`Error processing message ${message.id}`, {
                error: error.message,
                threadId: message.threadId
              });
              return null;
            }
          })
      );

      // Filter out null results and store in currentEmailBatch
      this.currentEmailBatch = processedEmails.filter(email => email !== null);

      logger.info(`Fetched ${this.currentEmailBatch.length} new unread emails from Primary category`);
      return this.currentEmailBatch;
    } catch (error) {
      console.error("Failed to fetch unread emails:", error);
      logger.error("Failed to fetch unread emails", { error: error.message });
      throw error;
    }
  }

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

  async getEmailEmbedding(email) {
    try {
      if (!this.embeddings) return null;

      // Check cache first
      if (this.emailEmbeddings.has(email.id)) {
        return this.emailEmbeddings.get(email.id);
      }

      // Prepare text for embedding
      const tokens = encode(`${email.subject} ${email.from} ${email.body}`);
      const limitedTokens = tokens.slice(0, 1000); // Limit to first 1000 tokens
      const text = decode(limitedTokens);

      // Get embedding with timeout
      const embedding = await Promise.race([
        this.embeddings.embedQuery(text),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Embedding timeout")), 5000)
        ),
      ]);

      if (Array.isArray(embedding) && embedding.length > 0) {
        this.emailEmbeddings.set(email.id, embedding);
        return embedding;
      }

      return null;
    } catch (error) {
      logger.error("Error generating embedding", {
        error: error.message,
        emailId: email?.id,
      });
      return null;
    }
  }

  async findSimilarEmails(sourceEmail) {
    try {
      if (!sourceEmail?.id) return [];

      // Get unprocessed emails
      const unprocessedEmails = this.currentEmailBatch.filter(
        (email) =>
          !this.processedEmails.has(email.id) && email.id !== sourceEmail.id
      );

      if (unprocessedEmails.length === 0) return [];

      // Quick pre-filter using signatures
      const sourceSignature = this.getEmailSignature(sourceEmail);
      const quickMatches = unprocessedEmails.filter((email) => {
        // Must be from same sender
        if (email.from !== sourceEmail.from) return false;

        // Quick signature comparison
        const signature = this.getEmailSignature(email);
        return signature === sourceSignature;
      });

      // If no quick matches, do basic filtering
      if (quickMatches.length === 0) {
        return this.preFilterEmails(sourceEmail, unprocessedEmails);
      }

      // If we have embeddings, use them for the quick matches
      if (this.embeddings) {
        try {
          // Get source embedding (with cache)
          const sourceEmbedding = await this.getEmailEmbedding(sourceEmail);
          if (!sourceEmbedding) {
            return quickMatches;
          }

          // Process matches in parallel with a smaller batch size
          const batchSize = 5;
          const similarEmails = [];

          // Process in batches
          for (let i = 0; i < quickMatches.length; i += batchSize) {
            const batch = quickMatches.slice(i, i + batchSize);
            const batchResults = await Promise.all(
              batch.map(async (email) => {
                try {
                  const embedding = await this.getEmailEmbedding(email);
                  if (!embedding) return null;

                  const similarity = this.cosineSimilarity(
                    sourceEmbedding,
                    embedding
                  );
                  return { email, similarity };
                } catch {
                  return null;
                }
              })
            );

            // Add successful results to similar emails
            similarEmails.push(
              ...batchResults
                .filter(
                  (result) =>
                    result && result.similarity > this.similarityThreshold
                )
                .map((result) => result.email)
            );

            // If we have enough similar emails, stop processing
            if (similarEmails.length >= 100) break;
          }

          logger.info(
            `Found ${similarEmails.length} similar emails using embeddings`
          );
          return similarEmails;
        } catch (embeddingError) {
          logger.error("Error using embeddings", {
            error: embeddingError.message,
          });
          return quickMatches;
        }
      }

      return quickMatches;
    } catch (error) {
      logger.error("Error finding similar emails", {
        error: error.message,
        sourceEmailId: sourceEmail?.id,
      });
      return [];
    }
  }

  preFilterEmails(sourceEmail, emails) {
    try {
      // Quick filtering based on basic criteria
      const matches = emails.filter((email) => {
        try {
          // Must have same sender
          if (email.from !== sourceEmail.from) {
            return false;
          }

          // Check subject similarity
          const subjectMatch = this.areSubjectsSimilar(
            email.subject,
            sourceEmail.subject
          );
          if (!subjectMatch) {
            return false;
          }

          // Check for similar format (optional)
          const formatMatch = this.hasSimilarFormat(
            email.body,
            sourceEmail.body
          );

          // Check for unsubscribe links (optional)
          const bothHaveUnsubscribe =
            this.hasUnsubscribeLink(email.body) &&
            this.hasUnsubscribeLink(sourceEmail.body);

          // Return true if either format matches or both have unsubscribe links
          return formatMatch || bothHaveUnsubscribe;
        } catch (error) {
          logger.error("Error comparing emails", {
            error: error.message,
            emailId: email?.id,
          });
          return false;
        }
      });

      logger.info(`Pre-filter found ${matches.length} potential matches`);
      return matches;
    } catch (error) {
      logger.error("Error in preFilterEmails", { error: error.message });
      return [];
    }
  }

  areSubjectsSimilar(subject1, subject2) {
    try {
      if (!subject1 || !subject2) return false;

      // Clean and normalize subjects
      const cleanSubject = (subject) => {
        return subject
          .toLowerCase()
          .replace(/\d+/g, "") // Remove numbers
          .replace(/[^\w\s]/g, "") // Remove special chars
          .replace(/fw|fwd|re/g, "") // Remove forward/reply prefixes
          .trim();
      };

      const clean1 = cleanSubject(subject1);
      const clean2 = cleanSubject(subject2);

      // Check for exact match after cleaning
      if (clean1 === clean2) return true;

      // Check if one is contained in the other
      if (clean1.includes(clean2) || clean2.includes(clean1)) return true;

      // Split into words and check for significant word overlap
      const words1 = new Set(clean1.split(/\s+/));
      const words2 = new Set(clean2.split(/\s+/));

      // Calculate word overlap
      const commonWords = [...words1].filter((word) => words2.has(word));
      const overlapRatio =
        commonWords.length / Math.max(words1.size, words2.size);

      return overlapRatio > 0.5; // Require 50% word overlap
    } catch (error) {
      logger.error("Error comparing subjects", { error: error.message });
      return false;
    }
  }

  cosineSimilarity(vecA, vecB) {
    try {
      if (
        !Array.isArray(vecA) ||
        !Array.isArray(vecB) ||
        vecA.length !== vecB.length
      ) {
        throw new Error("Invalid vectors for similarity calculation");
      }

      const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
      const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
      const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

      if (magnitudeA === 0 || magnitudeB === 0) {
        return 0;
      }

      const similarity = dotProduct / (magnitudeA * magnitudeB);
      return isNaN(similarity) ? 0 : similarity;
    } catch (error) {
      logger.error("Error calculating cosine similarity", {
        error: error.message,
      });
      return 0;
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
        // Remove excessive whitespace
        .replace(/\s+/g, " ")
        // Remove empty lines
        .replace(/^\s*[\r\n]/gm, "\n")
        // Normalize line endings
        .replace(/\r\n/g, "\n")
        // Remove lines with just dashes or underscores (often used as separators)
        .replace(/^[-_]{2,}$/gm, "")
        // Remove common footer patterns
        .replace(/^Disclaimer:.*$/m, "")
        .replace(/^Confidentiality notice:.*$/m, "")
        // Clean up multiple newlines
        .replace(/\n{3,}/g, "\n\n")
        // Trim whitespace
        .trim()
    );
  }

  parseEmail(emailData) {
    try {
      // Extract headers
      const headers = emailData.payload.headers;
      const subject = headers.find((h) => h.name === "Subject")?.value;
      const from = headers.find((h) => h.name === "From")?.value;

      // Extract body
      let body = "";

      // Function to recursively extract text from parts
      const extractText = (part) => {
        let text = "";

        if (
          part.mimeType &&
          part.mimeType.startsWith("text/") &&
          part.body?.data
        ) {
          const decodedText = Buffer.from(part.body.data, "base64").toString();
          text +=
            part.mimeType === "text/html"
              ? this.cleanHtml(decodedText)
              : decodedText;
        }

        if (part.parts) {
          for (const subPart of part.parts) {
            text += extractText(subPart);
          }
        }

        if (part.mimeType === "message/rfc822" && part.body.attachmentId) {
          const attachedMessage = part.parts?.[0];
          if (attachedMessage) {
            text += extractText(attachedMessage);
          }
        }

        return text;
      };

      // Process the email body starting from the root payload
      body = extractText(emailData.payload);

      // Clean up the body text
      body = this.cleanEmailBody(body);

      return {
        id: emailData.id,
        threadId: emailData.threadId,
        subject,
        from,
        body,
        internalDate: emailData.internalDate,
        headers: emailData.payload.headers,
      };
    } catch (error) {
      logger.error("Failed to parse email", { error: error.message });
      throw error;
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
    return email?.toLowerCase().trim() || '';
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
      to.split(',').forEach(addr => {
        const email = this.extractEmail(addr);
        if (email && email !== this.extractEmail(from)) { // Don't add if it's the sender
          toSet.add(email);
        }
      });
    }

    // Process CC recipients
    const ccSet = new Set();
    if (cc) {
      cc.split(',').forEach(addr => {
        const email = this.extractEmail(addr);
        if (email && !toSet.has(email)) { // Only add to CC if not in To
          ccSet.add(addr.trim());
        }
      });
    }

    // Add pollinations.ai to CC if not already in To
    if (!toSet.has('hello@pollinations.ai')) {
      ccSet.add('hello@pollinations.ai');
    }

    return {
      to: Array.from(toSet).join(', '),
      cc: Array.from(ccSet).join(', ')
    };
  }

  async sendResponse(emailId, response) {
    try {
      const email = await this.gmail.users.messages.get({
        userId: "me",
        id: emailId,
      });

      const headers = email.data.payload.headers;
      const from = headers.find((h) => h.name === "From")?.value;
      const to = headers.find((h) => h.name === "To")?.value;
      const cc = headers.find((h) => h.name === "Cc")?.value;
      const subject = headers.find((h) => h.name === "Subject")?.value;
      const references = headers.find((h) => h.name === "Message-ID")?.value;

      // Get deduplicated recipients
      const recipients = this.getUniqueRecipients(from, to, cc);

      // Ensure response has proper line breaks
      const formattedResponse = response
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const message = [
        "From: me",
        `To: ${from}`, // Original sender
        ...(recipients.cc ? [`Cc: ${recipients.cc}`] : []), // Only add Cc if there are CC recipients
        `Subject: Re: ${subject}`,
        `References: ${references}`,
        "Content-Type: text/plain; charset=utf-8",
        "MIME-Version: 1.0",
        "",
        formattedResponse,
      ].join("\n");

      const encodedMessage = Buffer.from(message)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      await this.gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: encodedMessage,
          threadId: email.data.threadId,
        },
      });

      // Mark original email as read and processed
      await this.gmail.users.messages.modify({
        userId: "me",
        id: emailId,
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      });

      this.processedEmails.add(emailId);
      this.currentEmailBatch = this.currentEmailBatch.filter(
        (email) => email.id !== emailId
      );

      logger.info(`Successfully sent response to email ${emailId} and marked as processed`);
      return true;
    } catch (error) {
      console.error(`Failed to send response to email ${emailId}:`, error);
      logger.error(`Failed to send response to email ${emailId}`, {
        error: error.message,
      });
      throw error;
    }
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

  async fetchEmailsSince(sinceTime) {
    try {
      logger.info(`Fetching emails since ${sinceTime}`);

      const response = await this.gmail.users.messages.list({
        userId: "me",
        q: "category:primary",
        maxResults: 500,
      });

      if (!response.data.messages) {
        return [];
      }

      const emails = await Promise.all(
        response.data.messages.map(async (message) => {
          const email = await this.gmail.users.messages.get({
            userId: "me",
            id: message.id,
          });
          return this.parseEmail(email.data);
        })
      );

      // Filter emails based on internal date
      const filteredEmails = emails.filter((email) => {
        const emailDate = new Date(parseInt(email.internalDate));
        return emailDate > sinceTime;
      });

      logger.info(`Found ${filteredEmails.length} Primary category emails since ${sinceTime}`);
      return filteredEmails;
    } catch (error) {
      logger.error("Failed to fetch emails since last summary", {
        error: error.message,
        sinceTime: sinceTime.toISOString(),
      });
      throw error;
    }
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

  async bulkMarkAsRead(emailIds) {
    const results = [];
    for (const emailId of emailIds) {
      try {
        await this.markAsRead(emailId);
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

  async fetchEmailsInRange(startTime, endTime) {
    try {
      logger.info(`Fetching emails between ${startTime} and ${endTime}`);

      const response = await this.gmail.users.messages.list({
        userId: "me",
        q: `category:primary after:${Math.floor(startTime.getTime() / 1000)} before:${Math.floor(endTime.getTime() / 1000)}`,
        maxResults: 500,
      });

      if (!response.data.messages) {
        logger.info("No messages found in the specified time range");
        return [];
      }

      const emails = await Promise.all(
        response.data.messages.map(async (message) => {
          const email = await this.gmail.users.messages.get({
            userId: "me",
            id: message.id,
          });
          return this.parseEmail(email.data);
        })
      );

      logger.info(`Found ${emails.length} emails in the specified time range`);
      return emails;
    } catch (error) {
      logger.error("Failed to fetch emails in range", {
        error: error.message,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });
      throw error;
    }
  }

  async createDraft(emailId, response) {
    try {
      const email = await this.gmail.users.messages.get({
        userId: "me",
        id: emailId,
      });

      const headers = email.data.payload.headers;
      const from = headers.find((h) => h.name === "From")?.value;
      const to = headers.find((h) => h.name === "To")?.value;
      const cc = headers.find((h) => h.name === "Cc")?.value;
      const subject = headers.find((h) => h.name === "Subject")?.value;
      const references = headers.find((h) => h.name === "Message-ID")?.value;

      // Get deduplicated recipients
      const recipients = this.getUniqueRecipients(from, to, cc);

      // Ensure response has proper line breaks
      const formattedResponse = response
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const message = [
        "From: me",
        `To: ${from}`, // Original sender
        ...(recipients.cc ? [`Cc: ${recipients.cc}`] : []), // Only add Cc if there are CC recipients
        `Subject: Re: ${subject}`,
        `References: ${references}`,
        "Content-Type: text/plain; charset=utf-8",
        "MIME-Version: 1.0",
        "",
        formattedResponse,
      ].join("\n");

      const encodedMessage = Buffer.from(message)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      await this.gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: {
            raw: encodedMessage,
            threadId: email.data.threadId,
          },
        },
      });

      await this.gmail.users.messages.modify({
        userId: "me",
        id: emailId,
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      });

      this.processedEmails.add(emailId);
      this.currentEmailBatch = this.currentEmailBatch.filter(
        (email) => email.id !== emailId
      );

      logger.info(`Successfully created draft response for email ${emailId} and marked as processed`);
      return true;
    } catch (error) {
      console.error(`Failed to create draft response for email ${emailId}:`, error);
      logger.error(`Failed to create draft response for email ${emailId}`, {
        error: error.message,
      });
      throw error;
    }
  }

  // Add new method for applying ToArchive label
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
}

module.exports = new EmailService();
