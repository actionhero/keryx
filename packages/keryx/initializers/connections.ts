import { api, Connection } from "../api";
import { Initializer } from "../classes/Initializer";

const namespace = "connections";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Connections["initialize"]>>;
  }
}

export class Connections extends Initializer {
  constructor() {
    super(namespace);
  }

  async initialize() {
    function find(type: string, identifier: string, id: string) {
      for (const connection of api.connections.connections.values()) {
        if (
          connection.type === type &&
          connection.id === id &&
          connection.identifier === identifier
        ) {
          return { connection };
        }
      }
      return { connection: undefined };
    }

    function destroy(type: string, identifier: string, id: string) {
      const { connection } = find(type, identifier, id);
      if (connection) {
        api.connections.connections.delete(connection.id);
        return [connection];
      }
      return [];
    }

    return {
      connections: new Map<string, Connection>(),
      find,
      destroy,
    };
  }
}
