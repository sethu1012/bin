import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useImmer } from "use-immer";
import { type z } from "zod";
import { http } from "~/services/api.services";
import {
  getAllDocuments,
  saveDocument,
  clearTaskCache,
  clearOldCache,
} from "~/utils/indexeddb";

import {
  agentKeyedOn,
  getAgentTaskDetails,
} from "~/services/SEFL/agent.services";
import { getGenericURL } from "~/utils/basic";
import { createZodSchema } from "~/utils/SEFL/zod";

type SchemaType = {
  type: Record<string, { schema: z.ZodType }>;
};
type IAgentStateContextProps = {
  data?: any;
  setData: Dispatch<SetStateAction<any | null>>;
  formFields?: any;
  setFormFields: any;
  formSchema?: z.ZodType | null;
  partialFormSchema?: z.ZodType | null;
  allFormFields?: Record<string, Record<string, any>>;
  setAllFormFields?: Dispatch<
    SetStateAction<Record<string, Record<string, any>>>
  >;
  setFormSchema: any;
  setPartialFormSchema: any;
  tableFields?: any;
  setAllSchemas?: Dispatch<SetStateAction<SchemaType>>;
  setPartialSchemas?: Dispatch<SetStateAction<SchemaType>>;
  allSchemas?: SchemaType;
  partialSchemas?: SchemaType;
  setTableFields?: any;
  allTableFields?: any;
  setAllTableFields?: any;
  values?: any;
  setValues: Dispatch<SetStateAction<any | null>>;
  documents?: any;
  setDocuments?: any;
  readOnly?: boolean;
  refreshData: () => void;
  isLoading: boolean;
  extractionVersion?: any;
  setExtractionVersion?: any;
  formStatus: "VALID" | "INVALID";
  prompts: any[];
};

interface IAgentStateProviderProps {
  children: ReactNode;
  isReadOnly?: boolean;
}

const AgentStateContext = createContext<IAgentStateContextProps>({
  setData: () => {},
  setFormFields: () => {},
  setFormSchema: () => {},
  setPartialFormSchema: () => {},
  setValues: () => {},
  setDocuments: () => {},
  refreshData: () => {},
  isLoading: true,
  formStatus: "INVALID",
  prompts: [],
} satisfies IAgentStateContextProps);
export const AgentStateProvider = ({
  children,
  isReadOnly,
}: IAgentStateProviderProps) => {
  const prevTaskIdRef = useRef<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [formFields, setFormFields] = useState<any>(null);
  const [allFormFields, setAllFormFields] = useState<Record<string, any>>({});
  const [allTableFields, setAllTableFields] = useState<Record<string, any>>({});
  const [tableFields, setTableFields] = useState<any>(null);
  const [values, setValues] = useImmer<any>(null);
  const [formSchema, setFormSchema] = useState<z.ZodType | null>(null);
  const [partialFormSchema, setPartialFormSchema] = useState<z.ZodType | null>(
    null,
  );
  const [allSchemas, setAllSchemas] = useState<SchemaType>({} as SchemaType);
  const [partialSchemas, setPartialSchemas] = useState<SchemaType>(
    {} as SchemaType,
  );
  const [documents, setDocuments] = useState<any>(null);
  const [readOnly] = useState<boolean>(isReadOnly ?? false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [extractionVersion, setExtractionVersion] = useState<any>(null);
  const [formStatus, setFormStatus] = useState<"VALID" | "INVALID">("VALID");
  const [prompts, setPrompts] = useState<any[]>([]);
  const roleid = localStorage.getItem("roleid") as string;

  // Helper function to fetch remaining documents in background
  const fetchRemainingDocuments = useCallback(
    async (taskId: string, zoningDocs: any, startIndex: number) => {
      const total = zoningDocs.imageurl.length;

      for (let i = startIndex; i < total; i++) {
        try {
          const [imageResponse, jsonResponse] = await Promise.all([
            http.get(getGenericURL(zoningDocs.imageurl[i])),
            http.get(getGenericURL(zoningDocs.jsonurl[i])),
          ]);

          const imageBlob = await imageResponse.blob();
          const jsonData = await jsonResponse.json();

          await saveDocument(taskId, i, imageBlob, jsonData);

          // Update context with newly fetched document
          setData((prev) => ({
            ...prev,
            zoningdocuments: {
              ...prev.zoningdocuments,
              allDocuments: [
                ...(prev.zoningdocuments?.allDocuments || []),
                {
                  index: i,
                  imageUrl: URL.createObjectURL(imageBlob),
                  jsonData,
                },
              ],
            },
          }));

          console.info(`Background downloaded document ${i + 1}/${total}`);
        } catch (err) {
          console.error(`Failed to download document ${i}:`, err);
        }
      }
    },
    []
  );

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    if (!readOnly && (roleid == "1" || roleid == "15")) {
      try {
        // Fetch main data
        const { data: mainData, status } = await getAgentTaskDetails(roleid);
        // console.log(mainData, status);
        if (status && (mainData as any)?.data != "") {
          // Pre-fetch zoning documents with IndexedDB caching
          const zoningDocs = (mainData as any)?.data?.zoningdocuments;
          const taskId = (mainData as any)?.data?.taskid;

          // Clear previous task's cache when task changes
          if (prevTaskIdRef.current && prevTaskIdRef.current !== taskId) {
            console.info(
              "Task changed, clearing previous cache:",
              prevTaskIdRef.current
            );
            clearTaskCache(prevTaskIdRef.current).catch((err) =>
              console.warn("Failed to clear task cache:", err)
            );
          }
          prevTaskIdRef.current = taskId;

          if (zoningDocs?.imageurl?.[0] && zoningDocs?.jsonurl?.[0]) {
            const totalCount = zoningDocs.imageurl.length;
            try {
              // 1. Check cache first
              const cachedDocs = await getAllDocuments(taskId);

              if (cachedDocs.length > 0) {
                // Cache hit - use first document immediately
                console.info(
                  `Using cached zoning documents: ${cachedDocs.length} available`
                );

                const enrichedData = {
                  ...(mainData as any)?.data,
                  zoningdocuments: {
                    ...zoningDocs,
                    currentDocument: {
                      imageUrl: cachedDocs[0].imageUrl,
                      jsonData: cachedDocs[0].jsonData,
                    },
                    allDocuments: cachedDocs,
                    totalCount,
                    fromCache: true,
                  },
                };

                setData(enrichedData);
                setFormStatus("VALID");

                // Trigger background fetch for any missing documents
                if (cachedDocs.length < totalCount) {
                  void fetchRemainingDocuments(taskId, zoningDocs, cachedDocs.length);
                }
              } else {
                // 2. Cache miss - fetch first document immediately
                const [imageResponse, jsonResponse] = await Promise.all([
                  http.get(getGenericURL(zoningDocs.imageurl[0])),
                  http.get(getGenericURL(zoningDocs.jsonurl[0])),
                ]);

                const imageBlob = await imageResponse.blob();
                const imageUrl = URL.createObjectURL(imageBlob);
                const jsonData = await jsonResponse.json();

                // Save first doc to cache
                await saveDocument(taskId, 0, imageBlob, jsonData);

                const enrichedData = {
                  ...(mainData as any)?.data,
                  zoningdocuments: {
                    ...zoningDocs,
                    currentDocument: { imageUrl, jsonData },
                    allDocuments: [{ index: 0, imageUrl, jsonData }],
                    totalCount,
                    fromCache: false,
                  },
                };

                setData(enrichedData);
                setFormStatus("VALID");

                // 3. Fetch remaining documents in background
                if (totalCount > 1) {
                  void fetchRemainingDocuments(taskId, zoningDocs, 1);
                }
              }
            } catch (e) {
              const enrichedData = {
                ...(mainData as any)?.data,
              };

              // delete zoningdocuments if imageurl or jsonurl is not available or improper
              delete enrichedData.zoningdocuments;
              setData(enrichedData);
              setFormStatus("VALID");
            }
          } else {
            setFormStatus("VALID");
            setData((mainData as any)?.data);
          }

          // Handle agent keyed on
          if (taskId) {
            const agentKeyedResponse = await agentKeyedOn(taskId, roleid);
            if (agentKeyedResponse.status) {
              console.info(
                "agentKeyedOn successful:",
                agentKeyedResponse.data,
              );
            } else {
              console.error("agentKeyedOn failed:", agentKeyedResponse.error);
            }
          }
        } else if (status && (mainData as any).statusCode == 501) {
          setFormStatus("INVALID");
        } else {
          setData(null);
        }
      } catch (error) {
        console.error("Error fetching data:", error);
        setData(null);
      } finally {
        setIsLoading(false);
      }
    }
  }, [readOnly, roleid, fetchRemainingDocuments]);

  // Clean up object URLs when data changes
  useEffect(() => {
    return () => {
      // Revoke all blob URLs from allDocuments
      data?.zoningdocuments?.allDocuments?.forEach((doc: any) => {
        if (doc?.imageUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(doc.imageUrl);
        }
      });

      // Also revoke currentDocument
      if (
        data?.zoningdocuments?.currentDocument?.imageUrl?.startsWith("blob:")
      ) {
        URL.revokeObjectURL(data.zoningdocuments.currentDocument.imageUrl);
      }

      // Legacy support: revoke from old format
      if (data?.zoningdocuments?.imageurl?.[0]?.startsWith("blob:")) {
        URL.revokeObjectURL(data.zoningdocuments.imageurl[0]);
      }
    };
  }, [data]);

  // Clear old cache on mount (cleanup entries older than 7 days)
  useEffect(() => {
    clearOldCache().catch((err) =>
      console.warn("Failed to clear old cache:", err)
    );
  }, []);

  useEffect(() => {
    async function initializeData() {
      await fetchData();
    }
    initializeData();
  }, [fetchData]);

  useEffect(() => {
    if (!data && !readOnly) {
      const intervalId = setInterval(async () => {
        await fetchData();
      }, 30000);
      return () => clearInterval(intervalId);
    }
  }, [data, readOnly, fetchData]);

  useEffect(() => {
    if (
      data != null &&
      data instanceof Object &&
      data.data !== "" &&
      data.schema != null
    ) {
      const docType = data.dbdata?.header?.[0].shippingcode;

      const { schema }: { schema: Record<string, Record<string, any>> } = data;
      const allFormData = Object.keys(schema).reduce(
        (accl: any, ll: string) => {
          accl[ll] = schema[ll].groupList.reduce((acc: any, sl: string) => {
            const section = schema[ll].group.find(
              (prop: any) => prop.id === sl,
            );
            if (section != null) {
              acc.push(section);
            }
            return acc;
          }, []);
          return accl;
        },
        {},
      );

      setAllFormFields(allFormData);
      // console.log("Form Fields: ", allFormData);

      setFormFields(allFormData[docType]);
      // console.log(allFormData);

      const allSchema: SchemaType = {
        type: {
          ...Object.keys(schema).reduce(
            (acc, key) => {
              acc[key] = {
                schema: createZodSchema(schema[key]),
              };
              return acc;
            },
            {} as Record<string, { schema: z.ZodType }>,
          ),
        },
      };

      const partialSchema: SchemaType = {
        type: {
          ...Object.keys(schema).reduce(
            (acc, key) => {
              acc[key] = {
                schema: createZodSchema(schema[key], true),
              };
              return acc;
            },
            {} as Record<string, { schema: z.ZodType }>,
          ),
        },
      };

      // console.log(docType, allSchema, partialSchema);
      setAllSchemas(allSchema);
      setFormSchema(allSchema.type[docType].schema);

      setPartialSchemas(partialSchema);
      setPartialFormSchema(partialSchema.type[docType].schema);

      const prompts = Object.keys(schema).reduce((prev: any, curr: any) => {
        prev[curr] = schema[curr].prompts;
        return prev;
      }, {});
      setPrompts(prompts);

      setValues((data as any)?.dbdata);
      setDocuments((data as any)?.documents);
      setExtractionVersion((data as any)?.extractionsource);
    }
  }, [data, setValues]);

  const refreshData = async () => {
    await fetchData();
  };

  return (
    <AgentStateContext.Provider
      value={{
        data,
        formFields,
        formSchema,
        partialFormSchema,
        allSchemas,
        setAllSchemas,
        partialSchemas,
        setPartialSchemas,
        tableFields,
        values,
        setData,
        setAllFormFields,
        allFormFields,
        setFormFields,
        setTableFields,
        setFormSchema,
        setPartialFormSchema,
        allTableFields,
        setAllTableFields,
        setValues,
        setDocuments,
        setExtractionVersion,
        extractionVersion,
        documents,
        readOnly,
        refreshData,
        isLoading,
        formStatus,
        prompts,
      }}
    >
      {children}
    </AgentStateContext.Provider>
  );
};

export function useAgent() {
  return useContext(AgentStateContext);
}
