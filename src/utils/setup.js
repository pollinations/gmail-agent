const fs = require("fs");
const path = require("path");
const logger = require("./logger");

function ensureDirectoriesExist() {
  const directories = [
    path.join(process.cwd(), "data"),
    path.join(process.cwd(), "logs"),
  ];

  directories.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`Created directory: ${dir}`);
    }
  });
}

function checkRequiredFiles() {
  const requiredFiles = [".env"];

  const missingFiles = requiredFiles.filter(
    (file) => !fs.existsSync(path.join(process.cwd(), file))
  );

  if (missingFiles.length > 0) {
    logger.error(`Missing required files: ${missingFiles.join(", ")}`);
    return false;
  }

  return true;
}

module.exports = {
  ensureDirectoriesExist,
  checkRequiredFiles,
};
