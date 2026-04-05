import type { SessionCreate } from "@backend/actions/session";
import type { UserCreate, UserView } from "@backend/actions/user";
import type { ActionResponse } from "keryx";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import { apiFetch } from "../utils/client";

type User = ActionResponse<UserView>["user"];

interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, []);

  async function hydrate() {
    const userId = localStorage.getItem("userId");
    if (!userId) {
      setLoading(false);
      return;
    }
    try {
      const res = await apiFetch<ActionResponse<UserView>>(`/user/${userId}`);
      setUser(res.user);
    } catch {
      localStorage.removeItem("userId");
    } finally {
      setLoading(false);
    }
  }

  async function signIn(email: string, password: string) {
    setError(null);
    try {
      const body = new FormData();
      body.append("email", email);
      body.append("password", password);
      const res = await apiFetch<ActionResponse<SessionCreate>>("/session", {
        method: "PUT",
        body,
      });
      setUser(res.user);
      localStorage.setItem("userId", String(res.user.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed");
      throw e;
    }
  }

  async function signUp(name: string, email: string, password: string) {
    setError(null);
    try {
      const body = new FormData();
      body.append("name", name);
      body.append("email", email);
      body.append("password", password);
      const res = await apiFetch<ActionResponse<UserCreate>>("/user", {
        method: "PUT",
        body,
      });
      setUser(res.user);
      localStorage.setItem("userId", String(res.user.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign up failed");
      throw e;
    }
  }

  async function signOut() {
    try {
      await apiFetch("/session", { method: "DELETE" });
    } finally {
      setUser(null);
      localStorage.removeItem("userId");
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        clearError: () => setError(null),
        signIn,
        signUp,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
