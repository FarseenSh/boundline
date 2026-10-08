import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { Shell } from "./components/Shell.jsx";
import { DrillPage, Drills } from "./pages/Drills.jsx";
import { Events } from "./pages/Events.jsx";
import { Evidence } from "./pages/Evidence.jsx";
import { LinePage } from "./pages/Line.jsx";
import { Obligations } from "./pages/Obligations.jsx";
import { Policy } from "./pages/Policy.jsx";
import { Reconciliation } from "./pages/Reconciliation.jsx";
import { Webhooks } from "./pages/Webhooks.jsx";
import { Router, usePath } from "./router.jsx";
import "./styles.css";
import { wagmiConfig } from "./wagmi.js";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Page() {
  const path = usePath();
  const line = /^\/lines\/(\d+)$/.exec(path);
  if (line) return <LinePage lineId={line[1]!} />;
  if (path === "/policy") return <Policy />;
  if (path === "/drills") return <Drills />;
  const drill = /^\/drills\/([a-z0-9-]+)$/.exec(path);
  if (drill) return <DrillPage id={drill[1]!} />;
  if (path === "/reconciliation") return <Reconciliation />;
  if (path === "/evidence") return <Evidence />;
  if (path === "/webhooks") return <Webhooks />;
  if (path === "/events") return <Events />;
  return <Obligations />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Router>
          <Shell>
            <Page />
          </Shell>
        </Router>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
