import FHIR from "fhirclient";
import extractResourcesFromELM from "./extractResourcesFromELM";
import cql from "cql-execution";
import valueSetDB from "../cql/valueset-db.json";
import r4HelpersELM from "../cql/r4/cdc_reference/json/FHIRHelpers.json";
import omtkdataELM from '../cql/r4/cdc_reference/json/OMTKData2020.json';
import omtklogicELM from '../cql/r4/cdc_reference/json/OMTKLogicMK2020.json';
import CDS_Commons from '../cql/r4/cdc_reference/json/OpioidCDSCommon.json';
import CDS_Commons_Config from '../cql/r4/cdc_reference/json/OpioidCDSCommonConfig.json';
import CDS_Routines from '../cql/r4/cdc_reference/json/OpioidCDSRoutines.json';
import rec10PatientView from '../cql/r4/cdc_reference/json/OpioidCDSREC10PatientView.json';
import rec11PatientView from '../cql/r4/cdc_reference/json/OpioidCDSREC11PatientView.json';
import cqlfhir from "../helpers/cql-exec-fhir";

export default function executeInternalCDSCall(recommendationNumber, collector) {
    let client, release, cdsLibrary;
    return new Promise(function (resolve) {
            // First get our authorized client and send the FHIR release to the next step
            const results = FHIR.oauth2.ready().then(function (clientArg) {
                client = clientArg;
                return client.getFhirRelease();
            })
                // then remember the release for later and get the release-specific library
                .then(function (releaseNum) {
                        release = releaseNum;
                        cdsLibrary = getCDSHooksLibrary(recommendationNumber);
                    })
                // then query the FHIR server for the patient, sending it to the next step
                .then(function () {
                        return client.patient.read();
                    })
                // then gather all the patient's relevant resource instances and send them in a bundle to the next step
                .then(function (pt) {
                    collector.push({ data: pt, url: 'Patient/' + pt.id });
                    let isFromOpiodRec = true;
                    const requests = extractResourcesFromELM(cdsLibrary, isFromOpiodRec).map(function (name) {
                        if (name === 'Patient') {
                            return [pt];
                        }
                        return doSearch(client, release, name, collector);
                    });
                    // Don't return until all the requests have been resolved
                    return Promise.all(requests).then((requestResults) => {
                            const resources: any[] = [];
                            requestResults.forEach((result: any) => {
                                    return resources.push(...result);
                                });
                            return {
                                resourceType: "Bundle",
                                entry: resources.map(function (r) {
                                        return ({ resource: r });
                                    })
                            };
                        });
                })
                // then execute the library and return the results (wrapped in a Promise)
                .then(function (bundle) {
                        const cdsPatientSource = getPatientSource(release);
                        const codeService = new cql.CodeService(valueSetDB);
                        const executor = new cql.Executor(cdsLibrary, codeService);
                        cdsPatientSource.loadBundles([bundle]);
                        const cdsExecutor = new cql.Executor(cdsLibrary, codeService);
                        const results = executor.exec(cdsPatientSource);
                        const cdsResults = cdsExecutor.exec(cdsPatientSource);
                        console.log(cdsResults.patientResults[Object.keys(results.patientResults)[0]]);
                        return results.patientResults[Object.keys(results.patientResults)[0]];
                    });
            resolve(results);
        });
}

function getPatientSource(release) {
    switch (release) {
        case 4:
            return cqlfhir.PatientSource['FHIRv401()'];
        default:
            throw new Error('Only FHIR R4 servers are supported');
    }
}

function doSearch(client, release, type, collector) {
    const params = new URLSearchParams();
    updateSearchParams(params, release, type);

    const resources = [];
    const uri = type + '?' + params;
    return new Promise(function (resolve) {
            const results = client.patient.request(uri, {
                pageLimit: 0,
                onPage: processPage(uri, collector, resources)
            }).then(function () {
                    return resources;
                }).catch(function (error) {
                    collector.push({ error: error, url: uri, type: type, data: error });
                    // don't return the error as we want partial results if available
                    // (and we don't want to halt the Promis.all that wraps this)
                    return resources;
                });
            resolve(results);
        });
}

function processPage(uri, collector, resources) {
    return function (bundle) {
        // Add to the collector
        let url = uri;
        if (bundle && bundle.link && bundle.link.some(function (l) {
            return l.relation === 'self' && l.url != null;
        })) {
            url = bundle.link.find(function (l) {
                return l.relation === 'self';
            }).url;
        }
        collector.push({ url: url, data: bundle });
        // Add to the resources
        if (bundle.entry) {
            bundle.entry.forEach(function (e) {
                return resources.push(e.resource);
            });
        }
    }
}

function updateSearchParams(params, release, type) {
    // If this is for Epic, there are some specific modifications needed for the queries to work properly
    if (process.env.REACT_APP_EPIC_SUPPORTED_QUERIES
        && process.env.REACT_APP_EPIC_SUPPORTED_QUERIES.toLowerCase() === 'true') {
        if (release === 2) {
            switch (type) {
                case 'Observation':
                    // Epic requires you to specify a category or code search parameter, so search on all categories
                    params.set('category', [
                        'social-history', 'vital-signs', 'imaging', 'laboratory', 'procedure', 'survey', 'exam', 'therapy'
                    ].join(','));
                    break;
                case 'MedicationOrder':
                    // Epic returns only active meds by default, so we need to specifically ask for other types
                    // NOTE: purposefully omitting entered-in-error
                    params.set('status', ['active', 'on-hold', 'completed', 'stopped', 'draft'].join(','));
                    break;
                case 'MedicationStatement':
                    // Epic returns only active meds by default, so we need to specifically ask for other types
                    // NOTE: purposefully omitting entered-in-error
                    params.set('status', ['active', 'completed', 'intended'].join(','));
                    break;
                default:
                //nothing
            }
        } else if (release === 4) {
            // NOTE: Epic doesn't currently support R4, but assuming R4 versions of Epic would need this
            switch (type) {
                case 'Observation':
                    // Epic requires you to specify a category or code search parameter, so search on all categories
                    params.set('category', [
                        'social-history', 'vital-signs', 'imaging', 'laboratory', 'procedure', 'survey', 'exam', 'therapy',
                        'activity'
                    ].join(','));
                    break;
                case 'MedicationRequest':
                    // Epic returns only active meds by default, so we need to specifically ask for other types
                    // NOTE: purposefully omitting entered-in-error
                    params.set('status', [
                        'active', 'on-hold', 'cancelled', 'completed', 'stopped', 'draft', 'unknown'
                    ].join(','));
                    break;
                case 'MedicationStatement':
                    // Epic returns only active meds by default, so we need to specifically ask for other types
                    // NOTE: purposefully omitting entered-in-error and not-taken
                    params.set('status', [
                        'active', 'completed', 'intended', 'stopped', 'on-hold', 'unknown'
                    ].join(','));
                    break;
                default:
                //nothing
            }
        }
    }
}

function getCDSHooksLibrary(recommendatation) {
    switch (recommendatation) {
        case 10:
            return new cql.Library(rec10PatientView, new cql.Repository({
                FHIRHelpers: r4HelpersELM,
                OMTKData2020: omtkdataELM,
                OMTKLogicMK2020: omtklogicELM,
                OpioidCDSCommon: CDS_Commons,
                OpioidCDSCommonConfig: CDS_Commons_Config,
                OpioidCDSRoutines: CDS_Routines
            }));
        case 11:
            return new cql.Library(rec11PatientView, new cql.Repository({
                FHIRHelpers: r4HelpersELM,
                OMTKData2020: omtkdataELM,
                OMTKLogicMK2020: omtklogicELM,
                OpioidCDSCommon: CDS_Commons,
                OpioidCDSCommonConfig: CDS_Commons_Config,
                OpioidCDSRoutines: CDS_Routines
            }));
        default:
            throw new Error('Only Recommendations 10 and 11 are supported');

    }
}
