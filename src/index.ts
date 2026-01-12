import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WarlonClient, OrderGroup } from "./client.js";

// Configuration schema for Smithery
export const configSchema = z.object({
  warlon_username: z.string().describe("Your Warteg Online username"),
  warlon_password: z.string().describe("Your Warteg Online password"),
});

// Client cache per session
const clients: Map<string, WarlonClient> = new Map();

async function getClient(
  config: z.infer<typeof configSchema>
): Promise<WarlonClient> {
  const sessionKey = `${config.warlon_username}`;

  if (!clients.has(sessionKey)) {
    const client = new WarlonClient();
    const success = await client.login(
      config.warlon_username,
      config.warlon_password
    );
    if (!success) {
      throw new Error("Login failed. Please check your credentials.");
    }
    clients.set(sessionKey, client);
  }

  return clients.get(sessionKey)!;
}

function parseDate(dateStr: string): Date {
  const date = new Date(dateStr + "T00:00:00+07:00"); // Jakarta timezone
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD`);
  }
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function getDayName(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "long" });
}

export default function createServer({
  config,
}: {
  config: z.infer<typeof configSchema>;
}) {
  const server = new McpServer({
    name: "Warteg Online",
    version: "1.0.0",
  });

  // Tool 1: Login
  server.registerTool(
    "login",
    {
      title: "Login",
      description: "Authenticate with the Warteg Online platform",
      inputSchema: {
        username: z.string().describe("Your Warteg Online username"),
        password: z.string().describe("Your Warteg Online password"),
      },
    },
    async ({ username, password }) => {
      const client = new WarlonClient();
      const success = await client.login(username, password);

      if (success) {
        clients.set(username, client);
        return {
          content: [
            { type: "text", text: `Successfully logged in as ${username}` },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: "Login failed. Please check your credentials.",
          },
        ],
      };
    }
  );

  // Tool 2: Get Package Orders
  server.registerTool(
    "get_package_orders",
    {
      title: "Get Package Orders",
      description: "Get all package orders for the authenticated user",
      inputSchema: {},
    },
    async () => {
      const client = await getClient(config);
      const orders = await client.getPackageOrders();

      if (!orders || orders.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify([], null, 2) }],
        };
      }

      const result = orders.map((order: any) => ({
        order_id: order.id || order.userPackageOrderId,
        package_name: order.packageName || "Unknown",
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 3: Get Order Details
  server.registerTool(
    "get_order_details",
    {
      title: "Get Order Details",
      description: "Get detailed information about a specific package order",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
      },
    },
    async ({ order_id }) => {
      const client = await getClient(config);
      const order = await client.getOrderDetails(order_id);

      const result = {
        order_id: order.id,
        package_name: order.packageName,
        description: order.packageDescription,
        total_days: order.totalDays,
        lunch_deliveries: order.lunchAmount,
        dinner_deliveries: order.dinnerAmount,
        available_addresses: order.addresses.length,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 4: Get Schedule
  server.registerTool(
    "get_schedule",
    {
      title: "Get Schedule",
      description: "Get the full delivery schedule for an order",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
      },
    },
    async ({ order_id }) => {
      const client = await getClient(config);
      const order = await client.getOrderDetails(order_id);
      const groups = await client.getAllOrderGroups(order_id);

      const schedule = groups
        .sort(
          (a, b) =>
            a.scheduledDate.getTime() - b.scheduledDate.getTime() ||
            a.orderType.localeCompare(b.orderType)
        )
        .map((group) => ({
          date: formatDate(group.scheduledDate),
          day: getDayName(group.scheduledDate),
          type: group.orderType,
          group_id: group.id,
          status: group.status,
          editable: group.isEditable,
        }));

      const result = {
        package_name: order.packageName,
        description: order.packageDescription,
        total_days: order.totalDays,
        lunch_count: order.lunchAmount,
        dinner_count: order.dinnerAmount,
        schedule,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 5: Get Orders by Date Range
  server.registerTool(
    "get_orders_by_date_range",
    {
      title: "Get Orders by Date Range",
      description: "Get all deliveries within a specific date range",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
        start_date: z
          .string()
          .describe("Start date in YYYY-MM-DD format (inclusive)"),
        end_date: z
          .string()
          .describe("End date in YYYY-MM-DD format (inclusive)"),
      },
    },
    async ({ order_id, start_date, end_date }) => {
      const client = await getClient(config);
      const start = parseDate(start_date);
      const end = parseDate(end_date);

      const orders = await client.getOrdersByDateRange(order_id, start, end);

      const result = {
        start_date,
        end_date,
        count: orders.length,
        deliveries: orders.map((order) => ({
          date: formatDate(order.scheduledDate),
          day: getDayName(order.scheduledDate),
          type: order.orderType,
          group_id: order.id,
          editable: order.isEditable,
        })),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 6: Reschedule Delivery
  server.registerTool(
    "reschedule_delivery",
    {
      title: "Reschedule Delivery",
      description: "Reschedule a single delivery to a new date",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
        group_id: z
          .number()
          .describe("The ID of the order group (delivery) to reschedule"),
        new_date: z
          .string()
          .describe("The new delivery date in YYYY-MM-DD format"),
        address_id: z.number().describe("The address ID for delivery"),
        order_type: z.string().describe('Either "LUNCH" or "DINNER"'),
      },
    },
    async ({ order_id, group_id, new_date, address_id, order_type }) => {
      const client = await getClient(config);

      try {
        const newDateTime = parseDate(new_date);

        if (newDateTime.getDay() === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Cannot schedule delivery on Sunday (${new_date}). Please choose a different date.`,
              },
            ],
          };
        }

        if (order_type !== "LUNCH" && order_type !== "DINNER") {
          return {
            content: [
              {
                type: "text",
                text: "order_type must be either 'LUNCH' or 'DINNER'",
              },
            ],
          };
        }

        const groups = await client.getAllOrderGroups(order_id);
        const targetGroup = groups.find((g) => g.id === group_id);

        if (!targetGroup) {
          return {
            content: [
              {
                type: "text",
                text: `Group ${group_id} not found in order ${order_id}`,
              },
            ],
          };
        }

        const success = await client.rescheduleOrder(
          group_id,
          newDateTime,
          address_id,
          order_type,
          order_id,
          targetGroup.scheduleId
        );

        if (success) {
          return {
            content: [
              {
                type: "text",
                text: `Successfully rescheduled delivery ${group_id} to ${new_date}`,
              },
            ],
          };
        }

        return {
          content: [
            { type: "text", text: `Failed to reschedule delivery ${group_id}` },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error}` }],
        };
      }
    }
  );

  // Tool 7: Bulk Reschedule
  server.registerTool(
    "bulk_reschedule",
    {
      title: "Bulk Reschedule",
      description:
        "Bulk reschedule all deliveries within a date range to new dates",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
        start_date: z
          .string()
          .describe("Start of the date range to reschedule (YYYY-MM-DD)"),
        end_date: z
          .string()
          .describe("End of the date range to reschedule (YYYY-MM-DD)"),
        target_start_date: z
          .string()
          .describe("The new start date for rescheduled deliveries"),
        order_types: z
          .string()
          .optional()
          .describe('Optional - "LUNCH", "DINNER", or "LUNCH,DINNER"'),
      },
    },
    async ({
      order_id,
      start_date,
      end_date,
      target_start_date,
      order_types,
    }) => {
      const client = await getClient(config);

      try {
        const start = parseDate(start_date);
        const end = parseDate(end_date);
        const target = parseDate(target_start_date);

        if (target.getDay() === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Cannot start rescheduling on Sunday (${target_start_date}).`,
              },
            ],
          };
        }

        let typesList: string[] | undefined;
        if (order_types) {
          typesList = order_types.split(",").map((t) => t.trim().toUpperCase());
          for (const t of typesList) {
            if (t !== "LUNCH" && t !== "DINNER") {
              return {
                content: [
                  {
                    type: "text",
                    text: `Invalid order type: ${t}. Must be 'LUNCH' or 'DINNER'`,
                  },
                ],
              };
            }
          }
        }

        const results = await client.bulkReschedule(
          order_id,
          start,
          end,
          target,
          typesList
        );

        let resultText = `Bulk Reschedule Results:\n- Successful: ${results.successCount}\n- Failed: ${results.failedCount}\n`;

        if (results.rescheduled.length > 0) {
          resultText += "\nRescheduled deliveries:\n";
          for (const item of results.rescheduled) {
            resultText += `  - ID ${item.groupId}: ${item.oldDate} -> ${item.newDate}\n`;
          }
        }

        return {
          content: [{ type: "text", text: resultText }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error}` }],
        };
      }
    }
  );

  // Tool 8: Get Available Addresses
  server.registerTool(
    "get_available_addresses",
    {
      title: "Get Available Addresses",
      description: "Get available delivery addresses for an order",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
      },
    },
    async ({ order_id }) => {
      const client = await getClient(config);
      const addresses = await client.getAvailableAddresses(order_id);

      if (!addresses || addresses.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify([], null, 2) }],
        };
      }

      const result = addresses.map((addr: any) => ({
        address_id: addr.id,
        label: addr.label || "",
        address: addr.address || "Unknown",
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 9: Get Delivery Summary
  server.registerTool(
    "get_delivery_summary",
    {
      title: "Get Delivery Summary",
      description: "Get a summary of delivery statistics",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
      },
    },
    async ({ order_id }) => {
      const client = await getClient(config);
      const order = await client.getOrderDetails(order_id);
      const groups = await client.getAllOrderGroups(order_id);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const lunchTotal = groups.filter((g) => g.orderType === "LUNCH").length;
      const dinnerTotal = groups.filter((g) => g.orderType === "DINNER").length;
      const lunchRemaining = groups.filter(
        (g) => g.orderType === "LUNCH" && g.scheduledDate >= today
      ).length;
      const dinnerRemaining = groups.filter(
        (g) => g.orderType === "DINNER" && g.scheduledDate >= today
      ).length;
      const editable = groups.filter((g) => g.isEditable).length;

      const dates = groups.map((g) => g.scheduledDate);
      const firstDate = dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : null;
      const lastDate = dates.length > 0 ? new Date(Math.max(...dates.map(d => d.getTime()))) : null;

      const result = {
        package_name: order.packageName,
        total_deliveries: groups.length,
        lunch: {
          total: lunchTotal,
          remaining: lunchRemaining,
          completed: lunchTotal - lunchRemaining,
        },
        dinner: {
          total: dinnerTotal,
          remaining: dinnerRemaining,
          completed: dinnerTotal - dinnerRemaining,
        },
        editable_count: editable,
        first_delivery: firstDate ? formatDate(firstDate) : null,
        last_delivery: lastDate ? formatDate(lastDate) : null,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 10: Skip Day
  server.registerTool(
    "skip_day",
    {
      title: "Skip Day",
      description:
        "Skip deliveries on a specific date by moving them to the end of the schedule",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
        skip_date: z.string().describe("The date to skip (YYYY-MM-DD)"),
        order_types: z
          .string()
          .optional()
          .describe('Optional - "LUNCH", "DINNER", or "LUNCH,DINNER"'),
      },
    },
    async ({ order_id, skip_date, order_types }) => {
      const client = await getClient(config);
      const skipDt = parseDate(skip_date);

      const groups = await client.getAllOrderGroups(order_id);
      const lastDate = new Date(
        Math.max(...groups.map((g) => g.scheduledDate.getTime()))
      );

      let typesList: string[] | undefined;
      if (order_types) {
        typesList = order_types.split(",").map((t) => t.trim().toUpperCase());
      }

      const toSkip = groups.filter((g) => {
        const sameDate =
          formatDate(g.scheduledDate) === formatDate(skipDt);
        const matchType = !typesList || typesList.includes(g.orderType);
        return sameDate && g.isEditable && matchType;
      });

      if (toSkip.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  message: `No editable deliveries found on ${skip_date}`,
                  skipped: [],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const skipped: any[] = [];
      let targetDate = new Date(lastDate.getTime() + 24 * 60 * 60 * 1000);

      // Skip Sundays
      while (targetDate.getDay() === 0) {
        targetDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
      }

      for (const group of toSkip) {
        const success = await client.rescheduleOrder(
          group.id,
          targetDate,
          group.addressId,
          group.orderType,
          order_id,
          group.scheduleId
        );

        if (success) {
          skipped.push({
            group_id: group.id,
            type: group.orderType,
            from_date: skip_date,
            to_date: formatDate(targetDate),
          });

          targetDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
          while (targetDate.getDay() === 0) {
            targetDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message: `Skipped ${skipped.length} deliveries from ${skip_date}`,
                skipped,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 11: Hold Deliveries
  server.registerTool(
    "hold_deliveries",
    {
      title: "Hold Deliveries",
      description: "Hold (pause) deliveries for a date range",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
        hold_start: z.string().describe("Start of hold period (YYYY-MM-DD)"),
        hold_end: z.string().describe("End of hold period (YYYY-MM-DD)"),
        order_types: z
          .string()
          .optional()
          .describe('Optional - "LUNCH", "DINNER", or "LUNCH,DINNER"'),
      },
    },
    async ({ order_id, hold_start, hold_end, order_types }) => {
      const client = await getClient(config);

      const start = parseDate(hold_start);
      const end = parseDate(hold_end);
      const resumeDate = new Date(end.getTime() + 24 * 60 * 60 * 1000);

      let typesList: string[] | undefined;
      if (order_types) {
        typesList = order_types.split(",").map((t) => t.trim().toUpperCase());
      }

      const results = await client.bulkReschedule(
        order_id,
        start,
        end,
        resumeDate,
        typesList
      );

      const result = {
        success: results.successCount > 0,
        hold_period: `${hold_start} to ${hold_end}`,
        resume_date: formatDate(resumeDate),
        deliveries_held: results.successCount,
        failed: results.failedCount,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 12: Change Address
  server.registerTool(
    "change_address",
    {
      title: "Change Address",
      description: "Change delivery address for specific deliveries",
      inputSchema: {
        order_id: z.number().describe("The ID of the package order"),
        new_address_id: z.number().describe("The new address ID to use"),
        date: z
          .string()
          .optional()
          .describe("Single date to change (YYYY-MM-DD)"),
        start_date: z
          .string()
          .optional()
          .describe("Start of date range (YYYY-MM-DD)"),
        end_date: z
          .string()
          .optional()
          .describe("End of date range (YYYY-MM-DD)"),
        order_types: z
          .string()
          .optional()
          .describe('Optional - "LUNCH", "DINNER", or "LUNCH,DINNER"'),
      },
    },
    async ({ order_id, new_address_id, date, start_date, end_date, order_types }) => {
      const client = await getClient(config);

      let start: Date, end: Date;

      if (date) {
        start = parseDate(date);
        end = start;
      } else if (start_date && end_date) {
        start = parseDate(start_date);
        end = parseDate(end_date);
      } else {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  message:
                    "Provide either 'date' or both 'start_date' and 'end_date'",
                  changed: [],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      let typesList: string[] | undefined;
      if (order_types) {
        typesList = order_types.split(",").map((t) => t.trim().toUpperCase());
      }

      let groups = await client.getOrdersByDateRange(order_id, start, end);
      if (typesList) {
        groups = groups.filter((g) => typesList!.includes(g.orderType));
      }

      if (groups.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  message: "No deliveries found in the specified range",
                  changed: [],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const changed: any[] = [];

      for (const group of groups) {
        if (!group.isEditable) continue;

        const success = await client.rescheduleOrder(
          group.id,
          group.scheduledDate,
          new_address_id,
          group.orderType,
          order_id,
          group.scheduleId
        );

        if (success) {
          changed.push({
            group_id: group.id,
            date: formatDate(group.scheduledDate),
            type: group.orderType,
            new_address_id,
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: changed.length > 0,
                message: `Changed address for ${changed.length} deliveries`,
                changed,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 13: Get Available Restrictions
  server.registerTool(
    "get_available_restrictions",
    {
      title: "Get Available Restrictions",
      description:
        "Get all available dietary restrictions (pantangan) that can be set",
      inputSchema: {},
    },
    async () => {
      const client = await getClient(config);
      const restrictions = await client.getAvailableRestrictions();

      const grouped: Record<string, any[]> = {};
      for (const r of restrictions) {
        const groupName = r.packageRestrictionGroup?.name || "Other";
        if (!grouped[groupName]) {
          grouped[groupName] = [];
        }
        grouped[groupName].push({ id: r.id, name: r.name });
      }

      const result = {
        restrictions_by_group: grouped,
        all_restrictions: restrictions.map((r: any) => ({
          id: r.id,
          name: r.name,
        })),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 14: Get My Restrictions
  server.registerTool(
    "get_my_restrictions",
    {
      title: "Get My Restrictions",
      description: "Get the current user's dietary restrictions (pantangan)",
      inputSchema: {},
    },
    async () => {
      const client = await getClient(config);
      const restrictions = await client.getUserRestrictions();

      if (!restrictions || restrictions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  has_restrictions: false,
                  message: "No dietary restrictions set",
                  restrictions: [],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const result = {
        has_restrictions: true,
        count: restrictions.length,
        restrictions: restrictions.map((r: any) => ({
          id: r.packageRestriction?.id,
          name: r.packageRestriction?.name,
        })),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool 15: Update Restrictions
  server.registerTool(
    "update_restrictions",
    {
      title: "Update Restrictions",
      description: `Update the user's dietary restrictions (pantangan).

Available IDs:
  Protein: 1=No Udang, 2=No Ikan, 3=No Sapi, 13=No Cumi, 15=No Seafood
  Additional: 4=No Kecombrang, 7=No Sayur, 10=No Telur, 12=No Olahan Susu, 14=No Kacang
  Rasa: 5=No Pedas, 11=No Mayo`,
      inputSchema: {
        restriction_ids: z
          .string()
          .optional()
          .describe(
            "Comma-separated list of restriction IDs to set. Use empty string or omit to clear all restrictions."
          ),
      },
    },
    async ({ restriction_ids }) => {
      const client = await getClient(config);

      let idsList: number[] = [];
      if (restriction_ids && restriction_ids.trim()) {
        try {
          idsList = restriction_ids.split(",").map((id) => parseInt(id.trim()));
          if (idsList.some(isNaN)) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: false,
                      message:
                        "Invalid restriction IDs. Use comma-separated numbers (e.g., '5,11')",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } catch {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    message:
                      "Invalid restriction IDs. Use comma-separated numbers (e.g., '5,11')",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      }

      const result = await client.updateRestrictions(idsList);

      if (result.success) {
        const updated = result.restrictions.map((r: any) => ({
          id: r.packageRestriction?.id,
          name: r.packageRestriction?.name,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: result.message,
                  restrictions_set: updated.length,
                  restrictions:
                    updated.length > 0
                      ? updated
                      : "None (all restrictions cleared)",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { success: false, message: result.message },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server.server;
}
