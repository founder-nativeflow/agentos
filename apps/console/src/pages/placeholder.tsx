import { Construction } from "lucide-react";
import { PageHeader } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";

export function PlannedCard({ what, phase }: { what: string; phase: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
        <Construction className="size-6 text-muted-foreground" />
        <p className="font-medium">{what} is coming in {phase}</p>
        <p className="max-w-md text-sm text-muted-foreground">
          The API route already answers with a clear "not implemented" error, so SDK code can be written against it today.
        </p>
      </CardContent>
    </Card>
  );
}

export function PlaceholderPage({ title, description, phase }: { title: string; description: string; phase: string }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <PlannedCard what={title} phase={phase} />
    </>
  );
}
