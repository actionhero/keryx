import crypto from "crypto";
import { eq } from "drizzle-orm";
import { api, Initializer, logger } from "keryx";
import { hashPassword } from "../ops/UserOps";
import { type User, users } from "../schema/users";

const namespace = "application";

const defaultUserEmail = "admin@keryxjs.com";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Application["initialize"]>>;
  }
}

export class Application extends Initializer {
  constructor() {
    super(namespace);
    this.startPriority = 1000;
  }

  async initialize() {
    return {} as { defaultUser: User };
  }

  async start() {
    let [defaultUser] = await api.db.db
      .select()
      .from(users)
      .where(eq(users.email, defaultUserEmail))
      .limit(1);

    if (!defaultUser) {
      logger.info(`Creating default user: ${defaultUserEmail}`);
      const [user] = await api.db.db
        .insert(users)
        .values({
          password_hash: await hashPassword(
            crypto.randomBytes(255).toString("hex"),
          ),
          email: defaultUserEmail,
          name: "Admin",
        })
        .returning();

      defaultUser = user;
    }

    api.application.defaultUser = defaultUser;
  }
}
