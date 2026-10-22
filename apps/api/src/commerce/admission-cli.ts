import { readFileSync } from "node:fs";
import { validateSalesAdmission } from "./admission";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--file" || !args[1]) {
  process.stdout.write(
    JSON.stringify({
      completeness: "incomplete",
      salesAuthorized: false,
      evidenceAuthenticity: "not_verified",
      issues: [
        {
          path: "$",
          code: "INPUT_ERROR",
          message: "用法：check:commerce --file <决策JSON文件>。",
        },
      ],
    }) + "\n",
  );
  process.exitCode = 2;
} else {
  try {
    const report = validateSalesAdmission(
      JSON.parse(readFileSync(args[1], "utf8")),
    );
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.completeness === "complete" ? 0 : 1;
  } catch {
    process.stdout.write(
      JSON.stringify({
        completeness: "incomplete",
        salesAuthorized: false,
        evidenceAuthenticity: "not_verified",
        issues: [
          {
            path: "$",
            code: "INPUT_ERROR",
            message: "无法读取有效 JSON 决策文件。",
          },
        ],
      }) + "\n",
    );
    process.exitCode = 2;
  }
}
