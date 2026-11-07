"use client";

import { useActionState, useState } from "react";
import ConfirmAction from "@/components/shared/confirm-action";
import FormStatus from "@/components/shared/form-status";
import SelectField from "@/components/shared/select-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type CatalogState, removeProduct, undeleteProduct } from "../actions";
import {
    CYCLES,
    labelFor,
    OPTION_TYPES,
    PRODUCT_STATUSES,
    PRODUCT_TYPES,
    PROVISIONING_MODES,
    toInput,
} from "../labels";
import {
    addOption,
    removeOption,
    saveOption,
    saveOptionValues,
    savePricing,
    saveProduct,
} from "./actions";

const initial: CatalogState = { status: "idle" };

export type ProductFields = {
    id: string;
    groupId: string;
    slug: string;
    name: string;
    type: string;
    status: string;
    tagline: string;
    description: string;
    sortOrder: number;
    module: string;
    moduleConfig: string;
    maxQuantity: number;
    provisioningMode: "manual" | "auto_on_payment";
    deleted: boolean;
};

export function ProductEditForm({
    product,
    groups,
    modules,
}: {
    product: ProductFields;
    groups: { value: string; label: string }[];
    modules: { value: string; label: string; description: string }[];
}) {
    const [state, formAction, pending] = useActionState(saveProduct, initial);

    return (
        <form action={formAction} className="max-w-3xl space-y-5">
            <input type="hidden" name="productId" value={product.id} />

            {state.status === "saved" ? (
                <FormStatus tone="success" message="Gespeichert." />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor="product-name">Name</Label>
                    <Input
                        id="product-name"
                        name="name"
                        defaultValue={product.name}
                        required
                        maxLength={200}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="product-slug">Kürzel</Label>
                    <Input
                        id="product-slug"
                        name="slug"
                        defaultValue={product.slug}
                        maxLength={80}
                    />
                </div>
                <SelectField
                    id="product-group"
                    name="groupId"
                    label="Gruppe"
                    options={groups}
                    defaultValue={product.groupId}
                />
                <SelectField
                    id="product-type"
                    name="type"
                    label="Art"
                    options={PRODUCT_TYPES}
                    defaultValue={product.type}
                />
                <SelectField
                    id="product-status"
                    name="status"
                    label="Status"
                    options={PRODUCT_STATUSES}
                    defaultValue={product.status}
                />
                <SelectField
                    id="product-provisioningMode"
                    name="provisioningMode"
                    // Not "Bereitstellung": the module select further down
                    // already carries that word, and two fields with one
                    // label is how an operator sets the wrong one.
                    label="Einrichtung der Leistung"
                    options={PROVISIONING_MODES}
                    defaultValue={product.provisioningMode}
                />
                <div className="space-y-2">
                    <Label htmlFor="product-maxQuantity">
                        Höchstmenge je Bestellung
                    </Label>
                    <Input
                        id="product-maxQuantity"
                        name="maxQuantity"
                        type="number"
                        min={1}
                        max={999}
                        defaultValue={product.maxQuantity}
                    />
                </div>
                <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="product-tagline">Zeile darunter</Label>
                    <Input
                        id="product-tagline"
                        name="tagline"
                        defaultValue={product.tagline}
                        maxLength={200}
                    />
                </div>
                <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="product-description">Beschreibung</Label>
                    <Textarea
                        id="product-description"
                        name="description"
                        defaultValue={product.description}
                        rows={4}
                        maxLength={4000}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="product-sortOrder">Reihenfolge</Label>
                    <Input
                        id="product-sortOrder"
                        name="sortOrder"
                        type="number"
                        min={0}
                        defaultValue={product.sortOrder}
                    />
                </div>
            </div>

            <div className="space-y-5 rounded-lg border p-5">
                <SelectField
                    id="product-module"
                    name="module"
                    label="Bereitstellung"
                    options={modules}
                    defaultValue={product.module}
                />
                <ul className="space-y-1 text-xs text-muted-foreground">
                    {modules.map((entry) => (
                        <li key={entry.value}>
                            <span className="font-medium text-foreground">
                                {entry.label}
                            </span>{" "}
                            — {entry.description}
                        </li>
                    ))}
                </ul>
                <div className="space-y-2">
                    <Label htmlFor="product-moduleConfig">
                        Moduleinstellungen (JSON)
                    </Label>
                    <Textarea
                        id="product-moduleConfig"
                        name="moduleConfig"
                        defaultValue={product.moduleConfig}
                        rows={4}
                        className="font-mono text-xs"
                    />
                    <p className="text-xs text-muted-foreground">
                        Wird gegen das Schema des Moduls geprüft. „Keine
                        Bereitstellung“ nimmt nur ein leeres Objekt.
                    </p>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={pending}>
                    {pending ? "Speichert …" : "Speichern"}
                </Button>
                {product.deleted ? (
                    <RestoreProduct productId={product.id} />
                ) : (
                    <ConfirmAction
                        action={removeProduct}
                        initialState={initial}
                        fields={{ productId: product.id }}
                        label="Produkt löschen"
                        title="Produkt löschen?"
                        description={`„${product.name}“ wird eingestellt und aus Shop und API genommen. Die Zeile bleibt erhalten, weil Rechnungen darauf zeigen können.`}
                        confirmLabel="Löschen"
                        confirmVariant="destructive"
                        variant="outline"
                        size="default"
                    />
                )}
            </div>
        </form>
    );
}

function RestoreProduct({ productId }: { productId: string }) {
    const [, formAction, pending] = useActionState(undeleteProduct, initial);

    return (
        <form action={formAction}>
            <input type="hidden" name="productId" value={productId} />
            <Button type="submit" variant="outline" disabled={pending}>
                Wiederherstellen
            </Button>
        </form>
    );
}

export type PricingCell = {
    cycle: string;
    currency: string;
    priceCents: number;
    setupFeeCents: number;
    trialDays: number;
};

/**
 * The matrix, submitted whole. A cell with an empty price is a combination
 * that is not sold — that is the only way a form can say "stop offering this
 * yearly", and it keeps the grid prices rather than prices plus switches.
 */
export function PricingMatrix({
    productId,
    currencies,
    cells,
}: {
    productId: string;
    currencies: string[];
    cells: PricingCell[];
}) {
    const [state, formAction, pending] = useActionState(savePricing, initial);

    const find = (cycle: string, currency: string) =>
        cells.find(
            (cell) => cell.cycle === cycle && cell.currency === currency,
        );

    return (
        <form action={formAction} className="space-y-5">
            <input type="hidden" name="productId" value={productId} />
            <input
                type="hidden"
                name="currencies"
                value={currencies.join(",")}
            />

            {state.status === "saved" ? (
                <FormStatus tone="success" message="Preise gespeichert." />
            ) : null}
            {state.status === "error" ? (
                <FormStatus tone="error" message={state.message} />
            ) : null}

            <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-4 py-3 font-medium">Zeitraum</th>
                            {currencies.map((currency) => (
                                <th
                                    key={currency}
                                    className="px-4 py-3 font-medium"
                                    colSpan={3}
                                >
                                    {currency}
                                </th>
                            ))}
                        </tr>
                        <tr>
                            <th className="px-4 pb-3" />
                            {currencies.flatMap((currency) => [
                                <th
                                    key={`${currency}-p`}
                                    className="px-4 pb-3 font-normal"
                                >
                                    Preis
                                </th>,
                                <th
                                    key={`${currency}-s`}
                                    className="px-4 pb-3 font-normal"
                                >
                                    Einrichtung
                                </th>,
                                <th
                                    key={`${currency}-t`}
                                    className="px-4 pb-3 font-normal"
                                >
                                    Testtage
                                </th>,
                            ])}
                        </tr>
                    </thead>
                    <tbody>
                        {CYCLES.map((cycle) => (
                            <tr
                                key={cycle.value}
                                className="border-b last:border-0"
                            >
                                <td className="px-4 py-3 whitespace-nowrap">
                                    {cycle.label}
                                </td>
                                {currencies.flatMap((currency) => {
                                    const cell = find(cycle.value, currency);
                                    const key = `${cycle.value}-${currency}`;

                                    return [
                                        <td
                                            key={`${key}-p`}
                                            className="px-4 py-2"
                                        >
                                            <Input
                                                name={`price-${key}`}
                                                defaultValue={toInput(
                                                    cell?.priceCents,
                                                )}
                                                inputMode="decimal"
                                                placeholder="—"
                                                aria-label={`Preis ${cycle.label} ${currency}`}
                                                className="w-28 tabular-nums"
                                            />
                                        </td>,
                                        <td
                                            key={`${key}-s`}
                                            className="px-4 py-2"
                                        >
                                            <Input
                                                name={`setup-${key}`}
                                                defaultValue={toInput(
                                                    cell?.setupFeeCents ?? 0,
                                                )}
                                                inputMode="decimal"
                                                aria-label={`Einrichtung ${cycle.label} ${currency}`}
                                                className="w-28 tabular-nums"
                                            />
                                        </td>,
                                        <td
                                            key={`${key}-t`}
                                            className="px-4 py-2"
                                        >
                                            <Input
                                                name={`trial-${key}`}
                                                type="number"
                                                min={0}
                                                max={365}
                                                defaultValue={
                                                    cell?.trialDays ?? 0
                                                }
                                                aria-label={`Testtage ${cycle.label} ${currency}`}
                                                className="w-20 tabular-nums"
                                                disabled={
                                                    cycle.value === "onetime"
                                                }
                                            />
                                        </td>,
                                    ];
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p className="text-xs text-muted-foreground">
                Ein leerer Preis heißt: in diesem Zeitraum nicht im Angebot. Die
                Einrichtungsgebühr wird einmalig berechnet, auch wenn Testtage
                laufen.
            </p>

            <Button type="submit" disabled={pending}>
                {pending ? "Speichert …" : "Preise speichern"}
            </Button>
        </form>
    );
}

export type OptionFields = {
    id: string;
    name: string;
    description: string;
    type: string;
    required: boolean;
    sortOrder: number;
    minQuantity: number;
    maxQuantity: number;
};

const cycleLabel = (cycle: string) => labelFor(CYCLES, cycle);

export type OptionValueFields = {
    id: string;
    name: string;
    isDefault: boolean;
    pricing: {
        cycle: string;
        currency: string;
        price: string;
        setup: string;
    }[];
};

function OptionFieldSet({
    prefix,
    option,
}: {
    prefix: string;
    option?: OptionFields;
}) {
    return (
        <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
                <Label htmlFor={`${prefix}-name`}>Name</Label>
                <Input
                    id={`${prefix}-name`}
                    name="name"
                    defaultValue={option?.name ?? ""}
                    required
                    maxLength={200}
                />
            </div>
            <SelectField
                id={`${prefix}-type`}
                name="type"
                label="Art"
                options={OPTION_TYPES}
                defaultValue={option?.type ?? "select"}
            />
            <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={`${prefix}-description`}>Erklärung</Label>
                <Input
                    id={`${prefix}-description`}
                    name="description"
                    defaultValue={option?.description ?? ""}
                    maxLength={1000}
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor={`${prefix}-minQuantity`}>
                    Kleinste Stückzahl
                </Label>
                <Input
                    id={`${prefix}-minQuantity`}
                    name="minQuantity"
                    type="number"
                    min={0}
                    defaultValue={option?.minQuantity ?? 0}
                />
            </div>
            <div className="space-y-2">
                <Label htmlFor={`${prefix}-maxQuantity`}>
                    Größte Stückzahl
                </Label>
                <Input
                    id={`${prefix}-maxQuantity`}
                    name="maxQuantity"
                    type="number"
                    min={0}
                    defaultValue={option?.maxQuantity ?? 10}
                />
            </div>
            <label className="flex items-end gap-3 pb-2 text-sm sm:col-span-2">
                <input
                    type="checkbox"
                    name="required"
                    defaultChecked={option?.required ?? false}
                    className="size-4"
                />
                Muss beantwortet werden
            </label>
        </div>
    );
}

export function NewOption({ productId }: { productId: string }) {
    const [state, formAction, pending] = useActionState(addOption, initial);
    const [open, setOpen] = useState(false);

    if (!open) {
        return (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Option anlegen
            </Button>
        );
    }

    return (
        <div className="rounded-lg border p-6">
            <form action={formAction} className="space-y-5">
                <input type="hidden" name="productId" value={productId} />

                {state.status === "error" ? (
                    <FormStatus tone="error" message={state.message} />
                ) : null}

                <OptionFieldSet prefix="new-option" />

                <div className="flex gap-2">
                    <Button type="submit" disabled={pending}>
                        {pending ? "Legt an …" : "Option anlegen"}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setOpen(false)}
                    >
                        Abbrechen
                    </Button>
                </div>
            </form>
        </div>
    );
}

/**
 * One option: its settings, its values and their prices. The value rows are
 * the ones that exist plus two blanks, which is enough to add without a
 * dynamic list and keeps the whole thing one plain form post.
 */
export function OptionEditor({
    productId,
    option,
    values,
    cycles,
    currencies,
}: {
    productId: string;
    option: OptionFields;
    values: OptionValueFields[];
    cycles: string[];
    currencies: string[];
}) {
    const [settings, settingsAction, savingSettings] = useActionState(
        saveOption,
        initial,
    );
    const [valueState, valuesAction, savingValues] = useActionState(
        saveOptionValues,
        initial,
    );
    const [open, setOpen] = useState(false);

    const rows = [
        ...values,
        ...Array.from({ length: 2 }, () => ({
            id: "",
            name: "",
            isDefault: false,
            pricing: [],
        })),
    ];

    const defaultRow = values.findIndex((value) => value.isDefault);

    const priced = (
        value: OptionValueFields,
        cycle: string,
        currency: string,
        field: "price" | "setup",
    ) =>
        value.pricing.find(
            (cell) => cell.cycle === cycle && cell.currency === currency,
        )?.[field] ?? "";

    return (
        <div className="space-y-5 rounded-lg border p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h3 className="text-sm font-medium tracking-tight">
                        {option.name}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {labelFor(OPTION_TYPES, option.type)}
                        {option.required ? " · Pflicht" : ""}
                        {values.length === 0
                            ? " · noch keine Werte"
                            : values.length === 1
                              ? " · 1 Wert"
                              : ` · ${values.length} Werte`}
                    </p>
                </div>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setOpen((value) => !value)}
                    >
                        {open ? "Schließen" : "Bearbeiten"}
                    </Button>
                    <ConfirmAction
                        action={removeOption}
                        initialState={initial}
                        fields={{ productId, optionId: option.id }}
                        label="Löschen"
                        title="Option löschen?"
                        description={`„${option.name}“ und alle ihre Werte werden entfernt.`}
                        confirmLabel="Löschen"
                        confirmVariant="destructive"
                    />
                </div>
            </div>

            {open ? (
                <div className="space-y-8 border-t pt-6">
                    <form action={settingsAction} className="space-y-5">
                        <input
                            type="hidden"
                            name="productId"
                            value={productId}
                        />
                        <input
                            type="hidden"
                            name="optionId"
                            value={option.id}
                        />
                        <input
                            type="hidden"
                            name="sortOrder"
                            value={option.sortOrder}
                        />

                        {settings.status === "saved" ? (
                            <FormStatus tone="success" message="Gespeichert." />
                        ) : null}
                        {settings.status === "error" ? (
                            <FormStatus
                                tone="error"
                                message={settings.message}
                            />
                        ) : null}

                        <OptionFieldSet
                            prefix={`option-${option.id}`}
                            option={option}
                        />

                        <Button type="submit" disabled={savingSettings}>
                            {savingSettings ? "Speichert …" : "Speichern"}
                        </Button>
                    </form>

                    <form action={valuesAction} className="space-y-5">
                        <input
                            type="hidden"
                            name="productId"
                            value={productId}
                        />
                        <input
                            type="hidden"
                            name="optionId"
                            value={option.id}
                        />
                        <input
                            type="hidden"
                            name="rowCount"
                            value={rows.length}
                        />
                        <input
                            type="hidden"
                            name="cycles"
                            value={cycles.join(",")}
                        />
                        <input
                            type="hidden"
                            name="currencies"
                            value={currencies.join(",")}
                        />

                        <h4 className="text-xs font-medium tracking-tight text-muted-foreground">
                            Werte und Aufpreise
                        </h4>

                        {valueState.status === "saved" ? (
                            <FormStatus
                                tone="success"
                                message="Werte gespeichert."
                            />
                        ) : null}
                        {valueState.status === "error" ? (
                            <FormStatus
                                tone="error"
                                message={valueState.message}
                            />
                        ) : null}

                        {cycles.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                Erst Preise für das Produkt setzen — ohne
                                Zeitraum gibt es nichts, worauf ein Aufpreis
                                sich beziehen könnte.
                            </p>
                        ) : (
                            <div className="overflow-x-auto rounded-lg border">
                                <table className="w-full text-sm">
                                    <thead className="border-b text-left text-xs text-muted-foreground">
                                        <tr>
                                            <th className="px-3 py-3 font-medium">
                                                Wert
                                            </th>
                                            <th className="px-3 py-3 font-medium">
                                                Vorgabe
                                            </th>
                                            {cycles.flatMap((cycle) =>
                                                currencies.flatMap(
                                                    (currency) => [
                                                        <th
                                                            key={`${cycle}-${currency}-p`}
                                                            className="px-3 py-3 font-medium whitespace-nowrap"
                                                        >
                                                            {cycleLabel(cycle)}
                                                        </th>,
                                                        <th
                                                            key={`${cycle}-${currency}-s`}
                                                            className="px-3 py-3 font-normal whitespace-nowrap"
                                                        >
                                                            Einrichtung
                                                        </th>,
                                                    ],
                                                ),
                                            )}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((value, index) => (
                                            <tr
                                                key={value.id || `new-${index}`}
                                                className="border-b last:border-0"
                                            >
                                                <td className="px-3 py-2">
                                                    <input
                                                        type="hidden"
                                                        name={`value-${index}-id`}
                                                        value={value.id}
                                                    />
                                                    <Input
                                                        name={`value-${index}-name`}
                                                        defaultValue={
                                                            value.name
                                                        }
                                                        placeholder={
                                                            value.id
                                                                ? undefined
                                                                : "neuer Wert"
                                                        }
                                                        aria-label={`Name des Wertes ${index + 1}`}
                                                        className="w-40"
                                                    />
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input
                                                        type="radio"
                                                        name="defaultRow"
                                                        value={index}
                                                        defaultChecked={
                                                            defaultRow === index
                                                        }
                                                        aria-label={`Wert ${index + 1} vorauswählen`}
                                                        className="size-4"
                                                    />
                                                </td>
                                                {cycles.flatMap((cycle) =>
                                                    currencies.flatMap(
                                                        (currency) => [
                                                            <td
                                                                key={`${cycle}-${currency}-p`}
                                                                className="px-3 py-2"
                                                            >
                                                                <Input
                                                                    name={`value-${index}-price-${cycle}-${currency}`}
                                                                    defaultValue={priced(
                                                                        value,
                                                                        cycle,
                                                                        currency,
                                                                        "price",
                                                                    )}
                                                                    inputMode="decimal"
                                                                    placeholder="0,00"
                                                                    aria-label={`Aufpreis ${cycleLabel(cycle)} ${currency}`}
                                                                    className="w-24 tabular-nums"
                                                                />
                                                            </td>,
                                                            <td
                                                                key={`${cycle}-${currency}-s`}
                                                                className="px-3 py-2"
                                                            >
                                                                <Input
                                                                    name={`value-${index}-setup-${cycle}-${currency}`}
                                                                    defaultValue={priced(
                                                                        value,
                                                                        cycle,
                                                                        currency,
                                                                        "setup",
                                                                    )}
                                                                    inputMode="decimal"
                                                                    placeholder="0,00"
                                                                    aria-label={`Einrichtung ${cycleLabel(cycle)} ${currency}`}
                                                                    className="w-24 tabular-nums"
                                                                />
                                                            </td>,
                                                        ],
                                                    ),
                                                )}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        <p className="text-xs text-muted-foreground">
                            Eine leere Zeile wird übergangen; ein geleerter Name
                            entfernt den Wert. Ein Wert ohne Aufpreis ist im
                            Preis enthalten.
                        </p>

                        <Button
                            type="submit"
                            disabled={savingValues || cycles.length === 0}
                        >
                            {savingValues ? "Speichert …" : "Werte speichern"}
                        </Button>
                    </form>
                </div>
            ) : null}
        </div>
    );
}
