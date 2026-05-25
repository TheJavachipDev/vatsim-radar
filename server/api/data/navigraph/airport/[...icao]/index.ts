import { handleH3Error } from '~/utils/server/h3';
import { findAndRefreshUserByCookie } from '~/utils/server/user';
import { getNavigraphGates, getNavigraphLayout, getNavigraphRunways } from '~/utils/server/navigraph';
import type {
    NavigraphAirportData,
    NavigraphGate,
    NavigraphLayout,
    NavigraphRunway,
} from '~/types/data/navigraph';
import type { AmdbLayerName, AmdbResponseStructure } from '@navigraph/amdb';
import type { PartialRecord } from '~/types';
import { multiLineString } from '@turf/helpers';
import type { Point } from 'geojson';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import { isDebug } from '~/utils/server/debug';

type StandGuidanceLineFeatures = AmdbResponseStructure['standguidanceline']['features'];

const allowedProperties: PartialRecord<AmdbLayerName, string[]> = {
    taxiwayintersectionmarking: ['idlin'],
    taxiwayguidanceline: ['color', 'style', 'idlin'],
    taxiwayholdingposition: ['idlin', 'catstop'],
    runwaythreshold: ['idthr', 'brngtrue', 'thrtype'],
    finalapproachandtakeoffarea: ['idrwy'],
    verticalpolygonalstructure: ['plysttyp', 'ident'],
    deicingarea: ['ident'],
    hotspot: ['idhot'],
    apronelement: ['idapron'],
} satisfies {
    [K in AmdbLayerName]?: (keyof AmdbResponseStructure[K]['features'][number]['properties'])[]
};

const allowedPropertiesSets = Object.fromEntries(Object.entries(allowedProperties).map(([key, value]) => [key, new Set(value)])) as PartialRecord<AmdbLayerName, Set<string>>;

export default defineEventHandler(async (event): Promise<NavigraphAirportData | undefined> => {
    const user = await findAndRefreshUserByCookie(event);

    const icao = getRouterParam(event, 'icao');

    if (icao?.length !== 4) {
        handleH3Error({
            event,
            statusCode: 400,
            data: 'Invalid code',
        });
        return;
    }

    const query = getQuery(event);
    const isLayout = query.layout !== '0' && !!user?.hasFms && user.hasCharts;
    const dataFromLayout = !!user?.hasFms && user.hasCharts && query.originalData !== '1';

    let layout: Partial<AmdbResponseStructure> | null | undefined = null;

    let gates: NavigraphGate[] | undefined;
    let runways: NavigraphRunway[] | undefined;

    if (isLayout || dataFromLayout) {
        layout = await getNavigraphLayout({ icao }).catch(() => undefined);
        if (layout && Object.values(layout).every(x => !x?.features?.length)) layout = undefined;
    }

    if (!dataFromLayout || !isLayout || !layout || !layout.standguidanceline?.features.length || !layout.parkingstandarea?.features.length) {
        if (!dataFromLayout || !layout) {
            gates = await getNavigraphGates({
                user,
                event,
                icao,
            });
        }

        runways = await getNavigraphRunways({
            user,
            event,
            icao,
        });

        if ((!gates && !dataFromLayout) || !runways) return;
    }

    if (layout && layout.standguidanceline?.features.length && layout.parkingstandarea?.features.length) {
        const standLinesByTermref = new Map<string, Map<string, StandGuidanceLineFeatures>>();

        for (const line of layout.standguidanceline.features) {
            const termref = line.properties.termref ?? '';
            let linesByStand = standLinesByTermref.get(termref);
            if (!linesByStand) {
                linesByStand = new Map();
                standLinesByTermref.set(termref, linesByStand);
            }

            for (const ident of line.properties.idstd?.split('_') ?? []) {
                let lines = linesByStand.get(ident);
                if (!lines) {
                    lines = [];
                    linesByStand.set(ident, lines);
                }

                lines.push(line);
            }
        }

        gates = layout.parkingstandarea.features.flatMap(area => {
            const { centroid } = (area.properties as unknown as { centroid: Point });

            const subGates = area.properties.idstd?.split('_');

            if (!subGates) {
                // TODO: Handle parkingstandareas with a null idstd

                return [];
            }

            const termref = area.properties.termref ?? '';
            const linesByStand = standLinesByTermref.get(termref);
            const guidanceLineNames = new Set<string>();

            // Generate stands for subgates which have associated standguidancelines
            const guidanceLineGates = subGates.flatMap(ident => {
                const applicableStandLines = linesByStand?.get(ident) ?? [];

                if (applicableStandLines.length === 0) {
                    return [];
                }

                guidanceLineNames.add(ident);

                const geometry = multiLineString(applicableStandLines.map(line => line.geometry.coordinates));

                const nearestPoint = nearestPointOnLine(geometry, centroid);

                const coords = nearestPoint.geometry.coordinates;

                return [{
                    gate_identifier: `${ ident }:${ area.properties.termref }`,
                    gate_longitude: coords[0],
                    gate_latitude: coords[1],
                    name: ident,
                    airport_identifier: area.properties.idarpt,
                }];
            });

            const remainingGates = subGates.filter(ident => !guidanceLineNames.has(ident));

            const coords = centroid.coordinates;

            // For all subGates which have no associated standguidancelines, place a gate at the centroid of the parkingstandarea
            const centroidGates = remainingGates.map(ident => ({
                gate_identifier: `${ ident }:${ area.properties.termref }`,
                gate_longitude: coords[0],
                gate_latitude: coords[1],
                name: ident,
                airport_identifier: area.properties.idarpt,
            }));

            return [...guidanceLineGates, ...centroidGates];
        });

        const _layout = layout as NavigraphLayout;

        Object.entries(_layout).forEach(([key, value]) => {
            if (key === 'hotspot') {
                value.features = value.features.map(feature => {
                    feature.geometry = feature.properties?.centroid;
                    return feature;
                }).filter(x => x.geometry);
            }

            const property = allowedPropertiesSets[key as AmdbLayerName];
            if (!property?.size) value.features.forEach(feature => feature.properties = {});
            else {
                value.features.forEach(feature => {
                    for (const i in feature.properties) {
                        if (!property.has(i)) delete feature.properties[i];
                    }
                });
            }
        });
    }

    if (layout?.runwaythreshold) layout.runwaythreshold.features = layout.runwaythreshold.features.filter(x => x.properties.thrtype === 0);

    if (!isDebug()) {
        setResponseHeader(event, 'Cache-Control', 'private, max-age=604800, stale-while-revalidate=86400, immutable');
    }

    return {
        airport: icao,
        runways: runways ?? [],
        gates: gates ?? [],
        layout: isLayout ? layout ?? undefined : undefined,
    };
});
