import bcrypt from "bcrypt";
import { UserRepo } from "../repositories/userRepo";

export interface UserListItem {
  id: number;
  login: string;
  disabled: boolean;
}

const BCRYPT_COST = 10;

export interface CreateUserInput {
  login: string;
  password: string;
}

export interface UpdateUserInput {
  password?: string;
  disabled?: boolean;
}

export class UserService {
  constructor(private repo: UserRepo) {}

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_COST);
  }

  async comparePassword(password: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(password, hashed);
  }

  async create(input: CreateUserInput): Promise<number> {
    // Hash password BEFORE entering the transaction (bcrypt is async; better-sqlite3
    // transactions are synchronous and cannot contain async operations).
    const hashed = await this.hashPassword(input.password);
    return this.repo.createIfNotExists(input.login, hashed);
  }

  async update(id: number, input: UpdateUserInput): Promise<void> {
    // Hash password OUTSIDE the transaction (bcrypt is async; better-sqlite3
    // transactions are synchronous). Then do the existence check + write inside
    // one transaction so a concurrent delete cannot interleave.
    let hashedPassword: string | undefined;
    if (input.password) {
      hashedPassword = await this.hashPassword(input.password);
    }
    const found = this.repo.updateIfFound(id, {
      hashedPassword,
      disabled: input.disabled,
    });
    if (!found) {
      const err = new Error("User not found") as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
  }

  async remove(id: number): Promise<void> {
    const found = this.repo.removeIfFound(id);
    if (!found) {
      const err = new Error("User not found") as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
  }

  list(): UserListItem[] {
    return this.repo.list().map(({ id, login, disabled }) => ({
      id,
      login,
      disabled: Boolean(disabled),
    }));
  }
}
