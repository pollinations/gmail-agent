const fs = require("fs");
const logger = require("../utils/logger");

class APILoggingService {
  constructor() {
    this.logFile = 'api_logs.txt';
  }

  formatJsonToMarkdown(obj, title = '', depth = 0) {
    const indent = '  '.repeat(depth);
    let markdown = title ? `${indent}# ${title}\n\n` : '';

    for (const [key, value] of Object.entries(obj)) {
      if (key === 'messages') {
        markdown += `${indent}## Messages:\n\n`;
        value.forEach((msg, index) => {
          const role = msg.role?.toUpperCase() || 'UNKNOWN';
          markdown += `${indent}### Message ${index + 1} [${role}]:\n`;
          
          if (role === 'SYSTEM') {
            markdown += `${indent}> 🔧 System Instruction:\n${indent}> ${msg.content}\n\n`;
          } else if (msg.content.startsWith('# Context')) {
            markdown += `${indent}> 📚 Context Information:\n${indent}> ${msg.content.replace(/\n/g, `\n${indent}> `)}\n\n`;
          } else {
            markdown += `${indent}${msg.content}\n\n`;
          }
        });
      } else if (key === 'choices') {
        // Since there's always only one choice, directly access its message content
        const message = value[0]?.message;
        if (message) {
          markdown += `${indent}## Response Content [${message.role?.toUpperCase()}]:\n${indent}${message.content}\n\n`;
        }
      } else if (key === 'usage') {
        markdown += `${indent}## Usage Stats:\n`;
        for (const [statKey, statValue] of Object.entries(value)) {
          markdown += `${indent}- ${statKey}: ${statValue}\n`;
        }
        markdown += '\n';
      } else if (Array.isArray(value)) {
        markdown += `${indent}## ${key}:\n`;
        value.forEach((item) => {
          if (typeof item === 'string') {
            markdown += `${indent}- ${item}\n`;
          }
        });
        markdown += '\n';
      } else if (typeof value === 'object' && value !== null) {
        markdown += `${indent}## ${key}:\n\n${this.formatJsonToMarkdown(value, '', depth + 1)}`;
      } else {
        markdown += `${indent}## ${key}:\n${indent}${value}\n\n`;
      }
    }
    return markdown;
  }

  logAPIRequest(endpoint, requestBody) {
    try {
      const logEntry = `\n${'='.repeat(80)}\n` +
        `# 🤖 API Call ${new Date().toISOString()}\n` +
        `${'='.repeat(80)}\n\n` +
        `## 🌐 Endpoint:\n${endpoint}\n\n` +
        `## 📤 Request:\n${this.formatJsonToMarkdown(requestBody)}`;
      fs.appendFileSync(this.logFile, logEntry);
    } catch (error) {
      logger.error("Error logging API request", { error: error.message });
    }
  }

  logAPIResponse(response) {
    try {
      fs.appendFileSync(this.logFile, `## 📥 Response:\n${this.formatJsonToMarkdown(response)}\n${'='.repeat(80)}\n\n`);
    } catch (error) {
      logger.error("Error logging API response", { error: error.message });
    }
  }

  logAPIError(errorText) {
    try {
      fs.appendFileSync(this.logFile, `## ❌ Error Response:\n\`\`\`\n${errorText}\n\`\`\`\n\n${'='.repeat(80)}\n\n`);
    } catch (error) {
      logger.error("Error logging API error", { error: error.message });
    }
  }
}

module.exports = new APILoggingService();
