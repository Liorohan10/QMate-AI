from langchain_openai import ChatOpenAI
import os
import httpx
client = httpx.Client(verify=False)
llm = ChatOpenAI(
   base_url="https://genailab.tcs.in", # set openai_api_base to the LiteLLMProxy
   model = "genailab-maas-gpt-5.4",
   api_key="sk-3IKtg4F8MAqoN2uRVSfDxQ",
   http_client = client
)

print(llm.invoke("Hi"))