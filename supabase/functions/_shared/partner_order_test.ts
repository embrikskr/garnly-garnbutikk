import { assertEquals } from "jsr:@std/assert@1";
import { byggPartnerordre, delNavn, enhetspris, partnerTag, velgSporing } from "./partner_order.ts";

Deno.test("delNavn: siste ord er etternavn", () => {
  assertEquals(delNavn("Anne Marie Hansen"), { firstName: "Anne Marie", lastName: "Hansen" });
  assertEquals(delNavn("Hansen"), { firstName: null, lastName: "Hansen" });
  assertEquals(delNavn("  "), { firstName: null, lastName: null });
});

Deno.test("enhetspris: linjetotal etter rabatt per stk", () => {
  assertEquals(enhetspris(239.85, 3), 79.95);
  assertEquals(enhetspris(100, 3), 33.33);
  assertEquals(enhetspris(50, 0), 0);
});

const grunnlag = {
  groupId: "g-1",
  orderName: "#1050",
  kunde: { email: "k@eksempel.dk", name: "Mette Jensen", address1: "Vestergade 1", address2: "", zip: "5000", city: "Odense C", countryCodeV2: "dk", phone: "+4512345678" },
  currency: "DKK",
  linjer: [{ partnerVariantId: "gid://shopify/ProductVariant/1", qty: 3, unitPrice: 79.95, title: "Tynn Silk Mohair 1012" }],
  frakt: 49,
  test: false,
  sendKvittering: true,
};

Deno.test("byggPartnerordre: betalt, med kunden, frakt og merke som finner den igjen", () => {
  const { order, options, total } = byggPartnerordre(grunnlag);
  assertEquals(total, 288.85);
  assertEquals(order.financialStatus, "PAID");
  assertEquals(order.taxesIncluded, true);
  assertEquals(order.currency, "DKK");
  assertEquals((order.shippingAddress as Record<string, unknown>).countryCode, "DK");
  assertEquals((order.shippingAddress as Record<string, unknown>).address2, null);
  assertEquals((order.shippingAddress as Record<string, unknown>).firstName, "Mette");
  assertEquals(order.lineItems, [{ variantId: "gid://shopify/ProductVariant/1", quantity: 3, priceSet: { shopMoney: { amount: "79.95", currencyCode: "DKK" } } }]);
  assertEquals(order.shippingLines, [{ title: "Fragt (Garnly)", priceSet: { shopMoney: { amount: "49.00", currencyCode: "DKK" } } }]);
  assertEquals((order.transactions as Array<{ amountSet: unknown }>)[0].amountSet, { shopMoney: { amount: "288.85", currencyCode: "DKK" } });
  assertEquals(order.tags, ["Garnly", partnerTag("g-1")]);
  assertEquals(order.sourceIdentifier, "g-1");
  assertEquals(options, { inventoryBehaviour: "DECREMENT_IGNORING_POLICY", sendReceipt: true, sendFulfillmentReceipt: false });
});

Deno.test("byggPartnerordre: uten frakt på andre del, testordre uten kvittering", () => {
  const { order, options, total } = byggPartnerordre({ ...grunnlag, frakt: null, test: true });
  assertEquals(order.shippingLines, []);
  assertEquals(total, 239.85);
  assertEquals(order.test, true);
  assertEquals((order.tags as string[]).includes("TEST"), true);
  assertEquals(options.sendReceipt, false);
});

Deno.test("velgSporing: første gyldige sending, helst med sporingsnummer", () => {
  assertEquals(velgSporing([]), null);
  assertEquals(velgSporing([{ createdAt: "2026-11-20T10:00:00Z", status: "CANCELLED", trackingInfo: [{ number: "X", url: null, company: null }] }]), null);
  assertEquals(
    velgSporing([
      { createdAt: "2026-11-20T09:00:00Z", status: "SUCCESS", trackingInfo: [] },
      { createdAt: "2026-11-20T10:00:00Z", status: "SUCCESS", trackingInfo: [{ number: "00370123", url: "https://spor", company: "PostNord DK" }] },
    ]),
    { createdAt: "2026-11-20T10:00:00Z", number: "00370123", url: "https://spor", company: "PostNord DK" },
  );
  assertEquals(velgSporing([{ createdAt: "2026-11-20T09:00:00Z", status: "SUCCESS", trackingInfo: [] }]), { createdAt: "2026-11-20T09:00:00Z", number: null, url: null, company: null });
});
