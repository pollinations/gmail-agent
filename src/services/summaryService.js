const { ChatOpenAI } = require("@langchain/openai");
const { PromptTemplate } = require("@langchain/core/prompts");
const config = require("../config/config");
const emailService = require("./emailService");
const logger = require("../utils/logger");
const { encode, decode } = require("gpt-3-encoder");

class SummaryService {
  constructor() {
    this.model = new ChatOpenAI({
      openAIApiKey: config.openai.apiKey,
      temperature: 0.7,
      modelName: "gpt-4o-mini",
      maxTokens: 4000,
    });
    this.MAX_TOKENS = 128000;
    this.MAX_RESPONSE_TOKENS = 4000;
    this.AVAILABLE_CONTEXT_TOKENS = this.MAX_TOKENS - this.MAX_RESPONSE_TOKENS;
  }

  getSummaryType() {
    const hour = new Date().getHours();
    if (hour <= 9) return "morning";
    if (hour > 9 && hour < 18) return "afternoon";
    if (hour >= 18) return "evening";
    return "regular";
  }

  safelyFormatContent(content, maxLength = 200) {
    try {
      if (!content) return "";
      return content
        .substring(0, maxLength)
        .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    } catch (error) {
      logger.error("Error formatting content", { error: error.message });
      return "";
    }
  }

  safelyFormatDate(timestamp) {
    try {
      if (!timestamp) return "Unknown Date";
      const date = new Date(parseInt(timestamp));
      return date.toISOString();
    } catch (error) {
      logger.error("Error formatting date", { error: error.message });
      return "Unknown Date";
    }
  }

  getTimeRangeForSummary(summaryType) {
    const now = new Date();
    const startTime = new Date(now);

    switch (summaryType) {
      case "morning":
        // For morning summary, look at emails since 5 PM previous day
        startTime.setDate(startTime.getDate() - 1);
        startTime.setHours(17, 0, 0, 0); // 5 PM previous day
        break;

      case "afternoon":
        // For afternoon summary, look at emails since 9 AM same day
        startTime.setHours(9, 0, 0, 0);
        break;

      case "evening":
        // For evening summary, look at emails since 2 PM same day
        startTime.setHours(14, 0, 0, 0);
        break;

      default:
        // For regular/quick summary, look at last 3 hours
        startTime.setHours(now.getHours() - 3);
        break;
    }

    return startTime;
  }

  async generateHourlySummary() {
    try {
      const currentTime = new Date();
      const summaryType = this.getSummaryType();
      const startTime = this.getTimeRangeForSummary(summaryType);

      logger.info(
        `Starting ${summaryType} summary generation from ${startTime.toISOString()} to ${currentTime.toISOString()}`
      );

      const emails = await emailService.fetchEmailsSince(startTime);
      logger.info(`Fetched ${emails.length} emails for ${summaryType} summary`);

      if (emails.length === 0) {
        return `No new emails requiring attention since ${startTime.toLocaleTimeString()} ${
          startTime.getDate() !== currentTime.getDate()
            ? "(yesterday)"
            : "(today)"
        }.`;
      }

      const header = this.getSummaryHeader(summaryType);
      const basePrompt = `You are an email summary assistant analyzing emails for the ${summaryType} summary.

${header}

STRICT RULES:
1. DO NOT generate email responses
2. DO NOT use greeting formats
3. ONLY use the exact format specified below
4. EXCLUDE all automated and marketing emails

EXCLUSION CRITERIA - Ignore these types:
- Automated notifications/alerts
- Newsletters/marketing emails
- System-generated messages
- Calendar invites/updates
- Subscription confirmations
- Receipts/invoices
- Social media notifications
- Promotional offers
- No-reply sender emails
- Delivery status updates

FOCUS CRITERIA - Only include emails that:
- Require human attention/response
- Contain business-critical information
- Include personal messages needing action
- Have time-sensitive requests
- Contain important project updates
- Ask direct questions needing answers

REQUIRED FORMAT:

1️⃣ BRIEF OVERVIEW
[2-3 sentences summarizing key actionable communications]

2️⃣ TOP 5 PRIORITY EMAILS
1. [Sender Name] - [Subject]
   Priority: [High/Medium]
   Action Needed: [Brief description of required action]

2. [Next priority email...]
   (Continue format for up to 5 emails)

3️⃣ KEY INSIGHTS
• [Key deadline or decision needed]
• [Important trend or pattern]
• [Critical upcoming action item]

EMAILS TO ANALYZE:

{emails}

Remember: Only include emails requiring human attention or action. Maintain the exact format specified above.`;

      // Calculate available tokens for emails
      const promptTokens = encode(basePrompt).length;
      const tokensPerEmail = 300;
      const maxEmails = Math.floor(
        (this.AVAILABLE_CONTEXT_TOKENS - promptTokens) / tokensPerEmail
      );

      // Take more emails but still respect config maximum if set
      const configMax =
        config.summary.maxEmailsInSummary || Number.MAX_SAFE_INTEGER;
      const limitedEmails = emails.slice(-Math.min(maxEmails, configMax));

      logger.info(
        `Processing ${limitedEmails.length} emails within token limit`
      );

      // Process emails in batches if needed
      const BATCH_SIZE = 100;
      let formattedEmails = [];

      for (let i = 0; i < limitedEmails.length; i += BATCH_SIZE) {
        const batch = limitedEmails.slice(i, i + BATCH_SIZE);
        const batchFormatted = batch
          .map((email) => {
            try {
              return `From: ${this.safelyFormatContent(email.from) || "Unknown"}
Subject: ${this.safelyFormatContent(email.subject) || "No Subject"}
Content: ${this.safelyFormatContent(email.body, 500)}
Date: ${this.safelyFormatDate(email.internalDate)}`;
            } catch (error) {
              logger.error(`Error formatting email ${email.id}`, {
                error: error.message,
                emailId: email.id,
              });
              return null;
            }
          })
          .filter(Boolean);

        formattedEmails = formattedEmails.concat(batchFormatted);
      }

      if (formattedEmails.length === 0) {
        return "Error: Unable to process emails for summary. Please try again later.";
      }

      const emailContent = formattedEmails.join("\n\n---\n\n");
      const totalTokens = encode(basePrompt + emailContent).length;

      logger.info(`Total tokens for request: ${totalTokens}`);
      if (totalTokens > this.AVAILABLE_CONTEXT_TOKENS) {
        logger.warn(`Token limit exceeded, truncating content`);
        // If we exceed token limit, truncate the content
        const truncatedContent = decode(
          encode(basePrompt + emailContent).slice(
            0,
            this.AVAILABLE_CONTEXT_TOKENS
          )
        );
        formattedEmails = [truncatedContent];
      }

      const prompt = PromptTemplate.fromTemplate(basePrompt);
      const formattedPrompt = await prompt.format({
        emails: formattedEmails.join("\n\n---\n\n"),
      });

      logger.info("Making request to GPT-4");
      const response = await this.model.invoke(formattedPrompt);
      logger.info("Received response from GPT-4");

      if (!response || !response.content) {
        throw new Error("Invalid response from GPT-4");
      }

      return response.content.trim();
    } catch (error) {
      logger.error("Error generating summary", {
        error: error.message,
        stack: error.stack,
        type: error.constructor.name,
      });

      if (error.message.includes("token")) {
        return "Error: The email content was too large to process. Please try with a shorter time range.";
      } else if (error.message.includes("rate limit")) {
        return "Error: Rate limit exceeded. Please try again in a few minutes.";
      } else if (error.message.includes("invalid_api_key")) {
        return "Error: OpenAI API key configuration issue. Please contact support.";
      }

      return "Error generating summary. Please try again later or contact support.";
    }
  }

  getSummaryHeader(type) {
    switch (type) {
      case "morning":
        return `🌅 MORNING OVERVIEW
Start your day with a clear picture of what needs attention.`;

      case "afternoon":
        return `🌞 MIDDAY CATCH-UP
Focus on progress and emerging priorities.`;

      case "evening":
        return `🌙 EVENING WRAP-UP
Review the day's developments and prepare for tomorrow.`;

      default:
        return `📊 EMAIL SUMMARY
Current status of important communications.`;
    }
  }
}

module.exports = new SummaryService();
