/*---------------------------------------------------------------------------------------------
 * Dev helper route (/token): signs in with the SPA client and shows the user's access token so
 * it can be pasted into the replica scripts (npm run replica:*). One-off use; tokens last ~1h.
 *--------------------------------------------------------------------------------------------*/
import { useEffect, useState } from "react";
import { useAuthorizationContext } from "./Authorization";

export function TokenView() {
  const { client, state } = useAuthorizationContext();
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const t = await client.getAccessToken();
        if (active) setToken(t);
      } catch (e) {
        if (active) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [client, state]);

  const wrap: React.CSSProperties = {
    fontFamily: "Segoe UI, system-ui, sans-serif",
    maxWidth: 760,
    margin: "60px auto",
    padding: "0 20px",
  };

  return (
    <div style={wrap}>
      <h2>iTwin access token</h2>
      <p style={{ color: "#5a6675" }}>
        Signed in as Mike → copy this token → paste it back to the assistant (or use it as
        <code> IMJS_ACCESS_TOKEN</code> for <code>npm run replica:*</code>). It expires in ~1 hour.
      </p>
      {err && (
        <p style={{ color: "#d6332e" }}>
          {err} — make sure APP-BST409 has redirect URI{" "}
          <code>http://localhost:3000/signin-callback</code> and scope <code>itwin-platform</code>.
        </p>
      )}
      {!token && !err && <p>Signing in… (a Bentley login may pop up)</p>}
      {token && (
        <>
          <textarea
            readOnly
            value={token}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              width: "100%",
              height: 160,
              fontFamily: "monospace",
              fontSize: 12,
              padding: 10,
              boxSizing: "border-box",
            }}
          />
          <button
            style={{
              marginTop: 12,
              padding: "8px 14px",
              fontSize: 14,
              fontWeight: 600,
              background: "#1b6ec2",
              color: "#fff",
              border: "none",
              borderRadius: 7,
              cursor: "pointer",
            }}
            onClick={() => {
              void navigator.clipboard.writeText(token).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied!" : "Copy token"}
          </button>
        </>
      )}
    </div>
  );
}
