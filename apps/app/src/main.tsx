import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { Shell } from "./components/Shell.jsx";
import { Borrow } from "./pages/Borrow.jsx";
import { Portfolio } from "./pages/Portfolio.jsx";
import { Protect } from "./pages/Protect.jsx";
import { Statements } from "./pages/Statements.jsx";
import { Router, usePath } from "./router.jsx";
import "./styles.css";
import { wagmiConfig } from "./wagmi.js";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Page() {
  const path = usePath();
  if (path === "/borrow") return <Borrow />;
  if (path === "/protect") return <Protect />;
  if (path === "/statements") return <Statements />;
  return <Portfolio />;
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
