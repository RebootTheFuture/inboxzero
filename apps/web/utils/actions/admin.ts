"use server";

import { z } from "zod";
import type Stripe from "stripe";
import { processHistoryForUser } from "@/app/api/google/webhook/process-history";
import { createScopedLogger } from "@/utils/logger";
import { deleteUser } from "@/utils/user/delete";
import prisma from "@/utils/prisma";
import { adminActionClient } from "@/utils/actions/safe-action";
import { SafeError } from "@/utils/error";
import { syncStripeDataToDb } from "@/ee/billing/stripe/sync-stripe";
import { getStripe } from "@/ee/billing/stripe";

const logger = createScopedLogger("Admin Action");

export const adminProcessHistoryAction = adminActionClient
  .metadata({ name: "adminProcessHistory" })
  .schema(
    z.object({
      emailAddress: z.string(),
      historyId: z.number().optional(),
      startHistoryId: z.number().optional(),
    }),
  )
  .action(
    async ({ parsedInput: { emailAddress, historyId, startHistoryId } }) => {
      await processHistoryForUser(
        {
          emailAddress,
          historyId: historyId ? historyId : 0,
        },
        {
          startHistoryId: startHistoryId
            ? startHistoryId.toString()
            : undefined,
        },
      );
    },
  );

export const adminDeleteAccountAction = adminActionClient
  .metadata({ name: "adminDeleteAccount" })
  .schema(z.object({ email: z.string() }))
  .action(async ({ parsedInput: { email } }) => {
    try {
      const userToDelete = await prisma.user.findUnique({ where: { email } });
      if (!userToDelete) throw new SafeError("User not found");

      await deleteUser({ userId: userToDelete.id });
    } catch (error) {
      logger.error("Failed to delete user", { email, error });
      throw new SafeError(
        `Failed to delete user: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return { success: "User deleted" };
  });

export const adminSyncStripeForAllUsersAction = adminActionClient
  .metadata({ name: "syncStripeForAllUsers" })
  .action(async () => {
    const users = await prisma.premium.findMany({
      where: { stripeCustomerId: { not: null } },
      select: { stripeCustomerId: true },
      orderBy: { updatedAt: "asc" },
    });
    for (const premium of users) {
      if (!premium.stripeCustomerId) continue;
      console.log(`Syncing Stripe for ${premium.stripeCustomerId}`);
      await syncStripeDataToDb({ customerId: premium.stripeCustomerId });
    }
  });

export const adminSyncAllStripeCustomersToDbAction = adminActionClient
  .metadata({ name: "adminSyncAllStripeCustomersToDb" })
  .action(async () => {
    const stripe = getStripe();

    logger.info("Starting sync of all Stripe customers to DB");

    let hasMore = true;
    let startingAfter: string | undefined;
    const allCustomers: Stripe.Customer[] = [];

    while (hasMore) {
      const customers: Stripe.Response<Stripe.ApiList<Stripe.Customer>> =
        await stripe.customers.list({
          limit: 100,
          starting_after: startingAfter,
          expand: ["data.subscriptions"],
        });

      allCustomers.push(...customers.data);

      hasMore = customers.has_more;
      if (hasMore) {
        startingAfter = customers.data[customers.data.length - 1]?.id;
      }
    }

    const activeCustomers = allCustomers.filter(
      (c) => c.subscriptions && c.subscriptions.data.length > 0,
    );

    logger.info(`Found ${activeCustomers.length} active customers in Stripe.`);

    for (const customer of activeCustomers) {
      if (!customer.email) {
        logger.warn("Customer in Stripe has no email", {
          customerId: customer.id,
        });
        continue;
      }

      const user = await prisma.user.findUnique({
        where: { email: customer.email },
        include: { premium: true },
      });

      if (!user) {
        logger.warn("No user found in our DB for stripe customer", {
          stripeCustomerId: customer.id,
          stripeCustomerEmail: customer.email,
        });
        continue;
      }

      if (user.premium) {
        if (
          user.premium.stripeCustomerId &&
          user.premium.stripeCustomerId !== customer.id
        ) {
          logger.warn("Stripe customer ID mismatch for user", {
            userId: user.id,
            email: user.email,
            dbStripeCustomerId: user.premium.stripeCustomerId,
            stripeCustomerId: customer.id,
          });
        }

        if (user.premium.stripeCustomerId !== customer.id) {
          await prisma.premium.update({
            where: { id: user.premium.id },
            data: { stripeCustomerId: customer.id },
          });
          logger.info("Updated stripe customer ID for user", {
            userId: user.id,
            email: user.email,
            stripeCustomerId: customer.id,
          });
        }
      } else {
        logger.warn(
          "User with stripe customer email exists, but has no premium account",
          {
            userId: user.id,
            email: user.email,
            stripeCustomerId: customer.id,
          },
        );
      }
    }
    logger.info("Finished syncing all Stripe customers to DB");
    return { success: `Synced ${activeCustomers.length} customers.` };
  });
