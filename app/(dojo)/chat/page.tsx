import { Suspense } from "react";
import { ChatUI } from "@/components/ChatUI";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  return (
    <Suspense>
      <ChatUI />
    </Suspense>
  );
}
