import os
import sys
import ctypes

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["OMP_NUM_THREADS"] = "1"

torch_lib = r"C:\Users\ADMIN\Downloads\Suriin-AI\web-application\.venv\Lib\site-packages\torch\lib"
os.add_dll_directory(torch_lib)

try:
    ctypes.PyDLL(os.path.join(torch_lib, "libiomp5md.dll"))
    ctypes.PyDLL(os.path.join(torch_lib, "uv.dll"))
    ctypes.PyDLL(os.path.join(torch_lib, "torch_global_deps.dll"))
    ctypes.PyDLL(os.path.join(torch_lib, "c10.dll"))
    ctypes.PyDLL(os.path.join(torch_lib, "torch_cpu.dll"))
    print("Preloaded all PyTorch DLLs!")
except Exception as ex:
    print("Preload exception:", ex)

print("Importing torch...")
import torch
print("SUCCESS! PyTorch version:", torch.__version__)

from transformers import AutoTokenizer, XLMRobertaConfig, XLMRobertaForSequenceClassification

MODEL_PATH = os.path.join(os.path.dirname(__file__), 'XLM_RoBERTa_Quantized')
WEIGHTS_PATH = os.path.join(MODEL_PATH, 'quantized_weight.pt')

print("Loading tokenizer...")
tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
config = XLMRobertaConfig.from_pretrained(MODEL_PATH)
raw_model = XLMRobertaForSequenceClassification(config)

print("Quantizing model architecture...")
quantized_model = torch.quantization.quantize_dynamic(
    raw_model,
    {torch.nn.Linear},
    dtype=torch.qint8
)

print("Loading quantized weights...")
quantized_model.load_state_dict(torch.load(WEIGHTS_PATH, map_location='cpu'))
model = quantized_model
model.eval()
print("SUCCESS! XLM-RoBERTa model fully loaded and initialized!")

test_text = "Good day po sa lahat! Looking for a secured passive income? Sumali na kayo sa aming PET Plan"
inputs = tokenizer(test_text, return_tensors='pt', truncation=True, max_length=512, padding=True)
with torch.no_grad():
    outputs = model(**inputs)
    probs = torch.nn.functional.softmax(outputs.logits, dim=-1).numpy()[0]

scam_prob = float(probs[1])
print(f"Inference output probabilities: {probs}")
print(f"Scam probability: {scam_prob * 100:.2f}%")
print(f"Prediction: {'Scam' if scam_prob >= 0.5 else 'Safe'}")
