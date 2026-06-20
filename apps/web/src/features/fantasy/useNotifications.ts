/**
 * Notification feed hook (item 11). Reads the manager's in-app feed for a league
 * and follows the per-user `notifications` WS topic so a reminder or recap shows
 * up live without a refetch. The topic is keyed server-side to the connected
 * user, so a push for another league is ignored here (filtered by leagueId).
 */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Notification, NotificationsResponse } from '@tickr/shared-types';
import { client } from '../../api/client';
import { socket } from '../../api/socket';
import { fantasyKeys } from './api';

function upsert(list: Notification[], next: Notification): Notification[] {
  // A recap re-push reuses the same id — replace in place, keeping it on top.
  const without = list.filter((n) => n.id !== next.id);
  return [next, ...without];
}

export function useNotifications(leagueId: string) {
  const queryClient = useQueryClient();
  const key = fantasyKeys.notifications(leagueId);

  const feed = useQuery({
    queryKey: key,
    queryFn: () => client.getNotifications(leagueId),
  });

  useEffect(() => {
    socket.connect();
    const topic = { kind: 'notifications' as const };
    socket.subscribe(topic);
    const off = socket.on('notification', (msg) => {
      if (msg.notification.leagueId !== leagueId) return; // another league
      queryClient.setQueryData<NotificationsResponse>(key, (prev) => ({
        notifications: upsert(prev?.notifications ?? [], msg.notification),
      }));
    });
    return () => {
      off();
      socket.unsubscribe(topic);
    };
    // Re-run only when the league changes; `key` is derived from leagueId and
    // queryClient is stable (mirrors useLeague's socket effect).
  }, [leagueId]);

  const markRead = useMutation({
    mutationFn: (nid: string) => client.markNotificationRead(leagueId, nid),
    onSuccess: (updated) => {
      queryClient.setQueryData<NotificationsResponse>(key, (prev) =>
        prev
          ? {
              notifications: prev.notifications.map((n) =>
                n.id === updated.id ? updated : n,
              ),
            }
          : prev,
      );
    },
  });

  const notifications = feed.data?.notifications ?? [];
  const unread = notifications.filter((n) => n.readAt == null).length;

  return { notifications, unread, isLoading: feed.isLoading, markRead };
}
