const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

class UserService {
  constructor() {
    this.dataPath = path.join(process.cwd(), "data");
    this.userFilePath = path.join(this.dataPath, "user.json");
    this.userData = null;
    this.initializeDataDirectory();
  }

  initializeDataDirectory() {
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath);
    }
  }

  async loadUserData() {
    try {
      if (fs.existsSync(this.userFilePath)) {
        const data = fs.readFileSync(this.userFilePath, "utf8");
        this.userData = JSON.parse(data);
        logger.info("User data loaded successfully");
        return this.userData;
      }
      return null;
    } catch (error) {
      logger.error("Error loading user data", { error: error.message });
      return null;
    }
  }

  async saveUserData(data) {
    try {
      this.userData = data;
      fs.writeFileSync(this.userFilePath, JSON.stringify(data, null, 2));
      logger.info("User data saved successfully");
    } catch (error) {
      logger.error("Error saving user data", { error: error.message });
      throw error;
    }
  }

  async getUserData() {
    if (!this.userData) {
      await this.loadUserData();
    }
    return this.userData;
  }

  async setupUserData() {
    const userData = await this.loadUserData();
    if (userData) {
      logger.info("Existing user data found");
      return userData;
    }

    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const question = (query) =>
      new Promise((resolve) => rl.question(query, resolve));

    try {
      console.log("\n👤 User Information Setup");

      const firstName = await question("Please enter your first name: ");
      const lastName = await question(
        "Please enter your last name (optional): "
      );

      const emailSignature = await question(
        "Would you like to set up an email signature? (y/n): "
      );

      let signature = "";
      if (emailSignature.toLowerCase() === "y") {
        signature = await question("Please enter your email signature: ");
      }

      const newUserData = {
        firstName,
        lastName,
        signature,
        preferences: {
          useSignature: emailSignature.toLowerCase() === "y",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await this.saveUserData(newUserData);
      logger.info("User data setup completed");
      return newUserData;
    } finally {
      rl.close();
    }
  }

  async updateUserData(updates) {
    const currentData = await this.getUserData();
    const updatedData = {
      ...currentData,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await this.saveUserData(updatedData);
    return updatedData;
  }
}

module.exports = new UserService();
