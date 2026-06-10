const fs = require("fs");
const path = require("path");

const MD_PATH = path.join(__dirname, "..", "Knowledge", "XAUUSD.md");

module.exports = async function handler(req, res) {
  const type = req.query.type || "all";

  try {
    const response = {};

    if (type === "all" || type === "rules") {
      if (fs.existsSync(MD_PATH)) {
        response.rules = {
          confluence: { primary: 3, secondary: 2, tertiary: 1, minScore: 7 },
          tds: { highConviction: 7 },
          version: "Institutional 2.0 (Markdown)"
        };
      }
    }

    if (type === "all" || type === "news") {
      response.news = [
        { event: "CPI m/m", impact: "High", currency: "USD", time: "12:30 GMT" },
        { event: "Unemployment Claims", impact: "Medium", currency: "USD", time: "12:30 GMT" }
      ];
    }

    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
