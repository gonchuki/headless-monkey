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
    const existing = this.repo.findByLogin(input.login);
    if (existing) {
      const err = new Error("Duplicate login") as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    const hashed = await this.hashPassword(input.password);
    return this.repo.create(input.login, hashed);
  }

  async update(id: number, input: UpdateUserInput): Promise<void> {
    const user = this.repo.findById(id);
    if (!user) {
      const err = new Error("User not found") as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    if (input.password) {
      const hashed = await this.hashPassword(input.password);
      this.repo.updatePassword(id, hashed);
    }
    if (input.disabled !== undefined) {
      this.repo.updateDisabled(id, input.disabled);
    }
  }

  async remove(id: number): Promise<void> {
    const user = this.repo.findById(id);
    if (!user) {
      const err = new Error("User not found") as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    this.repo.remove(id);
  }

  list(): UserListItem[] {
    return this.repo.list().map(({ id, login, disabled }) => ({
      id,
      login,
      disabled: Boolean(disabled),
    }));
  }
}
