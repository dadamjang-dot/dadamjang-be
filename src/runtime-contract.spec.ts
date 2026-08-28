import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const officialUrl = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem";
const checksum = "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3";

describe("backend runtime image contract", () => {
  const dockerfile = readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
  const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/backend.yml"), "utf8");

  it("copies only the checksum-verified official RDS CA bundle into runtime", () => {
    expect(dockerfile).toContain(`wget -q -O /tmp/aws-rds-global-bundle.pem ${officialUrl}`);
    expect(dockerfile).toContain(`echo "${checksum}  /tmp/aws-rds-global-bundle.pem" | sha256sum -c -`);
    expect(dockerfile).toContain(
      "COPY --from=build /tmp/aws-rds-global-bundle.pem /etc/ssl/certs/aws-rds-global-bundle.pem",
    );
  });

  it("fails checksum validation for mismatched bytes", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "dadamjang-rds-ca-"));
    const caPath = path.join(directory, "global-bundle.pem");
    writeFileSync(caPath, "mismatched bytes");

    try {
      const result = spawnSync("sha256sum", ["-c", "-"], {
        encoding: "utf8",
        input: `${checksum}  ${caPath}\n`,
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("FAILED");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("builds the pinned runtime image in backend CI", () => {
    expect(workflow).toContain("- run: docker build --tag dadamjang-backend-ci .");
  });
});
