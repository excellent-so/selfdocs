// A test file — exercises the scanner's "test" file-type classification.
import { User } from "../src/models/user.js";

test("create then list returns the user", async () => {
  const u = await User.create({ name: "Ada", email: "ada@example.com" });
  const all = await User.all();
  expect(all).toContainEqual(u);
});
