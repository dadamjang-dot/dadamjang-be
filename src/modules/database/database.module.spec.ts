import { DatabasePool } from "src/database/connection";
import { DatabaseHealth } from "./database.module";

describe("DatabaseHealth", () => {
  it("bounds only its SELECT 1 readiness query", async () => {
    const query = jest.fn().mockResolvedValue({});
    const health = new DatabaseHealth({ query } as unknown as DatabasePool);

    await health.check();

    expect(query).toHaveBeenCalledWith({ text: "SELECT 1", query_timeout: 3000 });
  });
});
