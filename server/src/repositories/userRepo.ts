import type { Db } from "../db/database";

export interface UserRow {
  id: number;
  login: string;
  hashed_password: string;
  disabled: number;
}

export class UserRepo {
  constructor(private db: Db) {}

  findByLogin(login: string): UserRow | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE login = ?`).get(login) as UserRow | undefined;
  }

  findById(id: number): UserRow | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  }

  list(): UserRow[] {
    return this.db.prepare(`SELECT * FROM users ORDER BY id`).all() as UserRow[];
  }

  create(login: string, hashedPassword: string): number {
    const result = this.db
      .prepare(`INSERT INTO users (login, hashed_password) VALUES (?, ?)`)
      .run(login, hashedPassword);
    return result.lastInsertRowid as number;
  }

  /** Atomically checks for a duplicate login and inserts if absent. Throws 409 on conflict. */
  createIfNotExists(login: string, hashedPassword: string): number {
    return this.db.transaction(() => {
      const existing = this.findByLogin(login);
      if (existing) {
        const err = new Error("Duplicate login") as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
      const result = this.db
        .prepare(`INSERT INTO users (login, hashed_password) VALUES (?, ?)`)
        .run(login, hashedPassword);
      return result.lastInsertRowid as number;
    })();
  }

  updatePassword(id: number, hashedPassword: string): void {
    this.db.prepare(`UPDATE users SET hashed_password = ? WHERE id = ?`).run(hashedPassword, id);
  }

  updateDisabled(id: number, disabled: boolean): void {
    this.db.prepare(`UPDATE users SET disabled = ? WHERE id = ?`).run(disabled ? 1 : 0, id);
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  }

  /** Atomically check existence + update password. Returns false if user not found. */
  updatePasswordIfFound(id: number, hashedPassword: string): boolean {
    return this.db.transaction(() => {
      const user = this.findById(id);
      if (!user) return false;
      this.updatePassword(id, hashedPassword);
      return true;
    })();
  }

  /** Atomically check existence + update disabled. Returns false if user not found. */
  updateDisabledIfFound(id: number, disabled: boolean): boolean {
    return this.db.transaction(() => {
      const user = this.findById(id);
      if (!user) return false;
      this.updateDisabled(id, disabled);
      return true;
    })();
  }

  /** Atomically check existence + update password and/or disabled. Returns false if user not found. */
  updateIfFound(id: number, changes: { hashedPassword?: string; disabled?: boolean }): boolean {
    return this.db.transaction(() => {
      const user = this.findById(id);
      if (!user) return false;
      if (changes.hashedPassword !== undefined) {
        this.updatePassword(id, changes.hashedPassword);
      }
      if (changes.disabled !== undefined) {
        this.updateDisabled(id, changes.disabled);
      }
      return true;
    })();
  }

  /** Atomically check existence + delete. Returns false if user not found. */
  removeIfFound(id: number): boolean {
    return this.db.transaction(() => {
      const user = this.findById(id);
      if (!user) return false;
      this.remove(id);
      return true;
    })();
  }
}
