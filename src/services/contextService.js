const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

class ContextService {
  constructor() {
    this.dataPath = path.join(process.cwd(), "data");
    this.contextFilePath = path.join(this.dataPath, "context.json");
    this.context = {
      projectInfo: {}, // Store project-related information
      contacts: {}, // Store contact-specific context
      terminology: {}, // Store domain-specific terms
      preferences: {}, // Store response preferences
    };
    this.initializeContext();
  }

  initializeContext() {
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath);
    }
    if (fs.existsSync(this.contextFilePath)) {
      try {
        this.context = JSON.parse(
          fs.readFileSync(this.contextFilePath, "utf8")
        );
        logger.info("Context loaded successfully");
      } catch (error) {
        logger.error("Error loading context", { error: error.message });
      }
    } else {
      this.saveContext();
    }
  }

  saveContext() {
    try {
      fs.writeFileSync(
        this.contextFilePath,
        JSON.stringify(this.context, null, 2)
      );
      logger.info("Context saved successfully");
    } catch (error) {
      logger.error("Error saving context", { error: error.message });
    }
  }

  addContext(category, key, value) {
    if (!this.context[category]) {
      this.context[category] = {};
    }
    this.context[category][key] = {
      value,
      updatedAt: new Date().toISOString(),
    };
    this.saveContext();
  }

  getContext(category, key) {
    return this.context[category]?.[key]?.value;
  }

  getAllContext() {
    return this.context;
  }

  getRelevantContext(email) {
    const relevantContext = {
      projectInfo: {},
      contacts: {},
      terminology: {},
      preferences: {},
    };

    // Extract relevant context based on email content
    for (const category in this.context) {
      for (const [key, data] of Object.entries(this.context[category])) {
        if (
          email.body.toLowerCase().includes(key.toLowerCase()) ||
          email.subject.toLowerCase().includes(key.toLowerCase())
        ) {
          relevantContext[category][key] = data.value;
        }
      }
    }

    return relevantContext;
  }
}

module.exports = new ContextService();
