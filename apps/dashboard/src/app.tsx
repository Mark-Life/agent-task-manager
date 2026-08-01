import { Badge } from "@workspace/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card";

const App = () => (
  <div className="flex min-h-svh items-center justify-center p-6">
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Agent Task Manager</CardTitle>
        <CardDescription>Operator dashboard scaffold</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">
          This is the Vite + React shell for the operator dashboard. It ships
          empty on purpose: task views, run status and telemetry panels are not
          built yet.
        </p>
        <Badge variant="secondary">Scaffold</Badge>
      </CardContent>
    </Card>
  </div>
);

export default App;
