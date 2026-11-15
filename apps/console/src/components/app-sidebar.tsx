import { NavLink } from "react-router-dom";
import {
  Bot,
  Boxes,
  CalendarClock,
  Cpu,
  Database,
  FileText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Plus,
  Puzzle,
  Server,
  Settings,
  Sparkles,
  Webhook,
  Workflow,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useLogout, useMe } from "@/lib/auth";

const groups = [
  {
    label: "Agents",
    items: [
      { to: "/overview", label: "Overview", icon: LayoutDashboard },
      { to: "/create", label: "Create", icon: Plus },
      { to: "/agents", label: "Agents", icon: Bot },
      { to: "/sessions", label: "Sessions", icon: MessagesSquare },
      { to: "/deployments", label: "Deployments", icon: CalendarClock },
      { to: "/workflows", label: "Workflows", icon: Workflow },
      { to: "/environments", label: "Environments", icon: Boxes },
      { to: "/memory", label: "Memory", icon: Database },
      { to: "/vaults", label: "Credential vaults", icon: KeyRound },
    ],
  },
  {
    label: "Resources",
    items: [
      { to: "/models", label: "Models", icon: Sparkles },
      { to: "/skills", label: "Skills", icon: Puzzle },
      { to: "/files", label: "Files", icon: FileText },
      { to: "/webhooks", label: "Webhooks", icon: Webhook },
      { to: "/workers", label: "Workers", icon: Server },
    ],
  },
];

export function AppSidebar() {
  const me = useMe();
  const logout = useLogout();
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Cpu className="size-4" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">AgentOS</div>
            <div className="text-xs text-muted-foreground">{me.data?.mode === "supabase" ? "Cloud" : "Local"}</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((g) => (
          <SidebarGroup key={g.label}>
            <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <NavLink to={item.to}>
                      {({ isActive }) => (
                        <SidebarMenuButton isActive={isActive}>
                          <item.icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      )}
                    </NavLink>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <NavLink to="/settings">
              {({ isActive }) => (
                <SidebarMenuButton isActive={isActive}>
                  <Settings />
                  <span>Settings</span>
                </SidebarMenuButton>
              )}
            </NavLink>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={logout}>
              <LogOut />
              <span>Sign out{me.data ? ` (${me.data.username})` : ""}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
