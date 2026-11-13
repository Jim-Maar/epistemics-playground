import { useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { browserId, post, setToken } from "../api";

function guessBrowserName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "this device";
  return `${browser} on ${device}`;
}

export function Login() {
  const [password, setPassword] = useState("");
  const [name, setName] = useState(guessBrowserName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ token: string }>("/auth/login", { password, browserId: browserId(), browserName: name.trim() || guessBrowserName() });
      setToken(result.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form className={error ? "login-card shake" : "login-card"} onSubmit={submit} key={error ?? "ok"}>
        <Lock size={22} className="login-icon" />
        <h1>Epistemics Playground</h1>
        <p className="muted">Enter the password to continue.</p>
        <label htmlFor="login-password">Password</label>
        <input id="login-password" className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
        <label htmlFor="login-browser">Name of this browser</label>
        <input id="login-browser" className="input" value={name} onChange={(event) => setName(event.target.value)} />
        <p className="muted small">You will see this name in Settings and on shared threads.</p>
        {error && <p className="error-note" role="alert">{error}</p>}
        <button className="btn primary block" disabled={busy || !password}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
