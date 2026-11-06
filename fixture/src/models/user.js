// The User model — an in-memory stand-in for a real table.
const rows = [];

export const User = {
  async all() {
    return rows.slice();
  },
  async create({ name, email }) {
    const user = { id: rows.length + 1, name, email, created_at: new Date().toISOString() };
    rows.push(user);
    return user;
  },
};
