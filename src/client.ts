/**
 * Warteg Online API Client
 *
 * A TypeScript client to interact with the Warteg Online self-service catering platform.
 * Supports authentication, fetching orders, and rescheduling deliveries.
 */

const BASE_URL = "https://customer.warloncatering.com";

// Jakarta timezone offset (UTC+7)
const JAKARTA_TZ_OFFSET = 7 * 60; // minutes

export interface OrderGroup {
  id: number;
  scheduleId: number;
  scheduledDate: Date;
  orderType: "LUNCH" | "DINNER";
  status: string;
  addressId: number;
  address: string | null;
  notes: string[];
  isEditable: boolean;
}

export interface PackageOrder {
  id: number;
  userId: number;
  packageId: number;
  packageName: string;
  packageDescription: string;
  totalDays: number;
  lunchAmount: number;
  dinnerAmount: number;
  schedules: any[];
  addresses: any[];
}

export interface BulkRescheduleResult {
  successCount: number;
  failedCount: number;
  rescheduled: Array<{ groupId: number; oldDate: string; newDate: string }>;
  failed: Array<{ groupId: number; error: string }>;
}

export class WarlonClient {
  private cookies: Map<string, string> = new Map();
  private isAuthenticated = false;
  private userData: any = null;

  private getHeaders(includeJson = false): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/login`,
    };

    if (includeJson) {
      headers["Content-Type"] = "application/json";
    }

    if (this.cookies.size > 0) {
      headers["Cookie"] = Array.from(this.cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }

    return headers;
  }

  private parseCookies(response: Response): void {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      // Parse multiple cookies from set-cookie header
      const cookieParts = setCookie.split(",");
      for (const part of cookieParts) {
        const match = part.trim().match(/^([^=]+)=([^;]*)/);
        if (match) {
          this.cookies.set(match[1], match[2]);
        }
      }
    }
  }

  async login(username: string, password: string): Promise<boolean> {
    try {
      // Visit login page to get cookies
      const loginPageRes = await fetch(`${BASE_URL}/login`, {
        headers: this.getHeaders(),
      });
      this.parseCookies(loginPageRes);

      // Perform login
      const response = await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: this.getHeaders(true),
        body: JSON.stringify({ username, password }),
      });

      this.parseCookies(response);

      if (!response.ok) {
        return false;
      }

      const data = await response.json();
      const message = (data.message || "").toLowerCase();

      if (
        message.includes("login successful") ||
        message.includes("success") ||
        data.data
      ) {
        this.userData = data.data || {};
        this.isAuthenticated = true;
        return true;
      }

      return false;
    } catch (error) {
      console.error("Login failed:", error);
      return false;
    }
  }

  private checkAuth(): void {
    if (!this.isAuthenticated) {
      throw new Error("Not authenticated. Call login() first.");
    }
  }

  async getPackageOrders(): Promise<any[]> {
    this.checkAuth();

    const response = await fetch(`${BASE_URL}/api/customer-package-orders`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch orders: ${response.status}`);
    }

    const data = await response.json();
    const result = data.data || {};

    if (typeof result === "object" && !Array.isArray(result)) {
      return result.data || [];
    }

    return Array.isArray(result) ? result : [];
  }

  async getOrderDetails(orderId: number): Promise<PackageOrder> {
    this.checkAuth();

    const response = await fetch(
      `${BASE_URL}/api/customer-package-orders/${orderId}`,
      {
        headers: this.getHeaders(),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch order details: ${response.status}`);
    }

    const data = await response.json();
    const orderData = data.data || {};

    return {
      id: orderData.id,
      userId: orderData.userId,
      packageId: orderData.packageId,
      packageName: orderData.packageName,
      packageDescription: orderData.packageDescription || "",
      totalDays: orderData.totalDays,
      lunchAmount: orderData.lunchAmount,
      dinnerAmount: orderData.dinnerAmount,
      schedules: orderData.userPackageOrderSchedules || [],
      addresses: orderData.user?.addresses || [],
    };
  }

  async getAllOrderGroups(orderId: number): Promise<OrderGroup[]> {
    const order = await this.getOrderDetails(orderId);
    const groups: OrderGroup[] = [];

    for (const schedule of order.schedules) {
      const utcDate = new Date(schedule.scheduledDate);
      // Convert to Jakarta timezone
      const jakartaDate = new Date(
        utcDate.getTime() + JAKARTA_TZ_OFFSET * 60 * 1000
      );

      for (const group of schedule.userPackageOrderGroups || []) {
        const notes: string[] = [];
        for (const detail of group.userPackageOrderDetails || []) {
          if (detail.note) {
            notes.push(detail.note);
          }
        }

        const customerAddress = group.customerAddress || {};
        const addressId = group.customerAddressId || customerAddress.id;
        const addressStr = customerAddress.address || group.address || null;

        groups.push({
          id: group.id,
          scheduleId: schedule.id,
          scheduledDate: jakartaDate,
          orderType: group.type,
          status: group.status,
          addressId,
          address: addressStr,
          notes,
          isEditable: group.status === "SCHEDULED",
        });
      }
    }

    return groups;
  }

  async rescheduleOrder(
    groupId: number,
    newDate: Date,
    addressId: number,
    orderType: string,
    packageOrderId: number,
    scheduleId: number,
    notes?: string[],
    deliveryTime?: string
  ): Promise<boolean> {
    this.checkAuth();

    const dateStr = newDate.toISOString().split("T")[0];
    const defaultTime =
      orderType === "LUNCH" ? "12:00 - 13:00" : "18:00 - 19:00";

    const payload = {
      packageOrderId: String(packageOrderId),
      orderGroupId: `${scheduleId}-${groupId}`,
      scheduledDate: dateStr,
      customerAddressId: addressId,
      mealType: orderType,
      notes: notes || [],
      cutlery: false,
      deliveryTime: deliveryTime || defaultTime,
      historyNote: "",
    };

    try {
      const response = await fetch(
        `${BASE_URL}/api/customer-package-orders/edit-order`,
        {
          method: "PUT",
          headers: this.getHeaders(true),
          body: JSON.stringify(payload),
        }
      );

      return response.ok;
    } catch (error) {
      console.error(`Failed to reschedule order ${groupId}:`, error);
      return false;
    }
  }

  async bulkReschedule(
    orderId: number,
    startDate: Date,
    endDate: Date,
    targetStartDate: Date,
    orderTypes?: string[]
  ): Promise<BulkRescheduleResult> {
    const types = orderTypes || ["LUNCH", "DINNER"];

    const results: BulkRescheduleResult = {
      successCount: 0,
      failedCount: 0,
      rescheduled: [],
      failed: [],
    };

    const groups = await this.getAllOrderGroups(orderId);

    // Filter groups within date range
    const groupsToReschedule = groups.filter((group) => {
      const groupDate = group.scheduledDate;
      return (
        groupDate >= startDate &&
        groupDate <= endDate &&
        types.includes(group.orderType) &&
        group.isEditable
      );
    });

    // Sort by date
    groupsToReschedule.sort(
      (a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime()
    );

    // Calculate new dates - skip Sundays
    let currentTarget = new Date(targetStartDate);
    const dayMapping = new Map<string, Date>();

    for (const group of groupsToReschedule) {
      const oldDateStr = group.scheduledDate.toISOString().split("T")[0];

      if (!dayMapping.has(oldDateStr)) {
        // Skip Sundays
        while (currentTarget.getDay() === 0) {
          currentTarget = new Date(
            currentTarget.getTime() + 24 * 60 * 60 * 1000
          );
        }

        dayMapping.set(oldDateStr, new Date(currentTarget));
        currentTarget = new Date(currentTarget.getTime() + 24 * 60 * 60 * 1000);
      }

      const newDate = dayMapping.get(oldDateStr)!;

      const success = await this.rescheduleOrder(
        group.id,
        newDate,
        group.addressId,
        group.orderType,
        orderId,
        group.scheduleId,
        group.notes.length > 0 ? group.notes : undefined
      );

      if (success) {
        results.successCount++;
        results.rescheduled.push({
          groupId: group.id,
          oldDate: oldDateStr,
          newDate: newDate.toISOString().split("T")[0],
        });
      } else {
        results.failedCount++;
        results.failed.push({
          groupId: group.id,
          error: "Reschedule failed",
        });
      }
    }

    return results;
  }

  async getOrdersByDateRange(
    orderId: number,
    startDate: Date,
    endDate: Date
  ): Promise<OrderGroup[]> {
    const groups = await this.getAllOrderGroups(orderId);

    return groups
      .filter((group) => {
        const groupDate = group.scheduledDate;
        return groupDate >= startDate && groupDate <= endDate;
      })
      .sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime());
  }

  async getAvailableAddresses(orderId: number): Promise<any[]> {
    const order = await this.getOrderDetails(orderId);
    return order.addresses;
  }

  async getAvailableRestrictions(): Promise<any[]> {
    this.checkAuth();

    const response = await fetch(
      `${BASE_URL}/api/package-restrictions/available`,
      {
        headers: this.getHeaders(),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch restrictions: ${response.status}`);
    }

    const data = await response.json();
    return data.data || [];
  }

  async getUserRestrictions(): Promise<any[]> {
    this.checkAuth();

    const response = await fetch(`${BASE_URL}/api/customer-package-orders`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user restrictions: ${response.status}`);
    }

    const data = await response.json();
    const result = data.data || {};

    if (typeof result === "object" && !Array.isArray(result)) {
      const orders = result.data || [];
      if (orders.length > 0) {
        const user = orders[0].user || {};
        return user.userPackageRestrictions || [];
      }
    }

    return [];
  }

  async updateRestrictions(
    restrictionIds: number[]
  ): Promise<{ success: boolean; message: string; restrictions: any[] }> {
    this.checkAuth();

    try {
      const response = await fetch(`${BASE_URL}/api/users/restrictions-update`, {
        method: "PUT",
        headers: this.getHeaders(true),
        body: JSON.stringify({ restrictionIds }),
      });

      if (!response.ok) {
        return {
          success: false,
          message: `Failed to update restrictions: ${response.status}`,
          restrictions: [],
        };
      }

      const data = await response.json();
      return {
        success: true,
        message: data.message || "Restrictions updated",
        restrictions: data.data || [],
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to update restrictions: ${error}`,
        restrictions: [],
      };
    }
  }
}
