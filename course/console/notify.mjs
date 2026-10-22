import { toast } from "vue-sonner";

// Operator notifications. Messages render as text nodes, so no HTML escaping is needed.
export function useNotification() {
  return {
    success: (message) => toast.success(message),
    error: (message) => toast.error(message),
    warning: (message) => toast.warning(message),
  };
}
