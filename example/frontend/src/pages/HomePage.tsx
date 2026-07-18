import { Link } from "react-router-dom";

import { useAuth } from "../hooks/useAuth";

export default function HomePage() {
  const { user } = useAuth();

  return (
    <div className="keryx-hero">
      <img src="/images/hearald.svg" alt="Keryx" className="hero-icon" />
      <h1>Keryx</h1>
      <p className="lead">
        The messenger of the gods. A modern TypeScript framework built on Bun
        for realtime AI, CLI, and web applications.
      </p>
      {user ? (
        <Link to="/chat" className="btn btn-primary btn-lg">
          Open Chat
        </Link>
      ) : (
        <div className="d-flex gap-3 justify-content-center">
          <Link to="/sign-in" className="btn btn-primary btn-lg">
            Sign In
          </Link>
          <Link to="/sign-up" className="btn btn-outline-primary btn-lg">
            Sign Up
          </Link>
        </div>
      )}
    </div>
  );
}
