import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppLayout } from "@/components/layout";
import { RequireAuth } from "@/lib/auth";
import { LoginPage } from "@/pages/login";
import { OverviewPage } from "@/pages/overview";
import { AgentsPage } from "@/pages/agents";
import { AgentDetailPage } from "@/pages/agent-detail";
import { ModelsPage } from "@/pages/models";
import { SettingsPage } from "@/pages/settings";
import { PlaceholderPage } from "@/pages/placeholder";
import { EnvironmentsPage } from "@/pages/environments";
import { SessionsPage } from "@/pages/sessions";
import { SessionDetailPage } from "@/pages/session-detail";
import { FilesPage } from "@/pages/files";
import { VaultsPage } from "@/pages/vaults";
import { DeploymentDetailPage, DeploymentsPage } from "@/pages/deployments";
import { CreatePage } from "@/pages/create";
import { WorkflowDetailPage, WorkflowsPage } from "@/pages/workflows";
import "./index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

const planned = [
  { path: "memory", title: "Memory", description: "Persistent, versioned memory for agents.", phase: "Phase 3" },
  { path: "skills", title: "Skills", description: "Instructions and scripts agents load when needed.", phase: "Phase 3" },
  { path: "webhooks", title: "Webhooks", description: "Event notifications to your endpoints.", phase: "Phase 3" },
  { path: "workers", title: "Workers", description: "Laptops and VPC machines that can run sessions.", phase: "Phase 2" },
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route element={<AppLayout />}>
                <Route index element={<Navigate to="/overview" replace />} />
                <Route path="overview" element={<OverviewPage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:id" element={<AgentDetailPage />} />
                <Route path="models" element={<ModelsPage />} />
                <Route path="environments" element={<EnvironmentsPage />} />
                <Route path="sessions" element={<SessionsPage />} />
                <Route path="sessions/:id" element={<SessionDetailPage />} />
                <Route path="files" element={<FilesPage />} />
                <Route path="vaults" element={<VaultsPage />} />
                <Route path="deployments" element={<DeploymentsPage />} />
                <Route path="deployments/:id" element={<DeploymentDetailPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="create" element={<CreatePage />} />
                <Route path="workflows" element={<WorkflowsPage />} />
                <Route path="workflows/:id" element={<WorkflowDetailPage />} />
                <Route path="pipelines" element={<Navigate to="/workflows" replace />} />
                {planned.map((p) => (
                  <Route key={p.path} path={p.path} element={<PlaceholderPage title={p.title} description={p.description} phase={p.phase} />} />
                ))}
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
