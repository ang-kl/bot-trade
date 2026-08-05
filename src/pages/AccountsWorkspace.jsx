// Accounts › Workspace — the logs and backtest history for ONE account.
//
// A5 shipped /state/workspace-log and /state/workspace-backtests with nothing
// reading them, and that gap was recorded rather than glossed over. This page
// is the reader. It sits beside Workflow audit under Accounts, because both
// answer "what happened on this account", one from the trade side and one
// from the operator side.
import Card from '../components/common/Card.jsx'
import SectionNavFab from '../components/common/SectionNavFab.jsx'
import AccountsSubNav from '../components/AccountsSubNav.jsx'
import WorkspaceHistory from '../components/WorkspaceHistory.jsx'
import { agentConfigured } from '../lib/agent-api.js'

export default function AccountsWorkspace() {
  return (
    <div className="space-y-3">
      <SectionNavFab />
      <AccountsSubNav />
      {!agentConfigured() && (
        <Card className="text-(length:--fs-body)">Agent not connected — configure it on the Connect tab.</Card>
      )}
      <Card><WorkspaceHistory /></Card>
    </div>
  )
}
