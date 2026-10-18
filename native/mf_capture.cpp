// Windows microphone capture via Media Foundation (no PortAudio dependency).
// Pipeline reference: record_windows 1.0.7, used by wenzflow's record 6.2.1.
// This standalone implementation uses Windows SDK interfaces; no Flutter code is linked.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <mmdeviceapi.h>
#include <fcntl.h>
#include <io.h>
#include <memory>
#include <wrl/client.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
static constexpr DWORD FIRST_AUDIO_STREAM = static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM);

static std::string utf8(const std::wstring& s) {
    if (s.empty()) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
    std::string result(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), result.data(), n, nullptr, nullptr);
    return result;
}
static std::string quote(const std::string& s) {
    std::ostringstream out;
    out << '"';
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') out << '\\' << static_cast<char>(c);
        else if (c < 32) out << "\\u00" << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(c) << std::dec;
        else out << static_cast<char>(c);
    }
    return out.str() + '"';
}
static void check(HRESULT hr, const char* stage) {
    if (FAILED(hr)) {
        std::ostringstream message;
        message << stage << " failed (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << ")";
        throw std::runtime_error(message.str());
    }
}
struct Runtime {
    Runtime() {
        check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "CoInitializeEx");
        const HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
        if (FAILED(hr)) { CoUninitialize(); check(hr, "MFStartup"); }
    }
    ~Runtime() { MFShutdown(); CoUninitialize(); }
};
struct Source {
    ComPtr<IMFMediaSource> value;
    ~Source() { if (value) value->Shutdown(); }
};
static ComPtr<IMFAttributes> attributes() {
    ComPtr<IMFAttributes> result;
    check(MFCreateAttributes(&result, 4), "MFCreateAttributes");
    return result;
}
struct Device { std::wstring name, id; bool is_default = false; };
static std::wstring string_attribute(IMFAttributes* attrs, REFGUID key) {
    LPWSTR text = nullptr;
    UINT32 length = 0;
    check(attrs->GetAllocatedString(key, &text, &length), "GetAllocatedString");
    std::wstring result(text, length);
    CoTaskMemFree(text);
    return result;
}
static std::vector<Device> devices() {
    auto attrs = attributes();
    check(attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_GUID), "Set audio source type");
    IMFActivate** entries = nullptr;
    UINT32 count = 0;
    std::wstring default_id;
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          IID_PPV_ARGS(&enumerator)), "Create audio endpoint enumerator");
    ComPtr<IMMDevice> default_device;
    const HRESULT default_hr = enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &default_device);
    if (SUCCEEDED(default_hr)) {
        LPWSTR endpoint = nullptr;
        check(default_device->GetId(&endpoint), "Get default capture endpoint");
        default_id = endpoint;
        CoTaskMemFree(endpoint);
    } else if (default_hr != E_NOTFOUND) check(default_hr, "GetDefaultAudioEndpoint");
    check(MFEnumDeviceSources(attrs.Get(), &entries, &count), "MFEnumDeviceSources");
    std::vector<Device> result;
    try {
        for (UINT32 i = 0; i < count; ++i) result.push_back({
            string_attribute(entries[i], MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME),
            string_attribute(entries[i], MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_ENDPOINT_ID)});
    } catch (...) {
        for (UINT32 i = 0; i < count; ++i) entries[i]->Release();
        CoTaskMemFree(entries);
        throw;
    }
    for (UINT32 i = 0; i < count; ++i) entries[i]->Release();
    CoTaskMemFree(entries);
    for (auto& device : result) device.is_default = _wcsicmp(device.id.c_str(), default_id.c_str()) == 0;
    return result;
}
static bool stop_requested() {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    if (input == nullptr || input == INVALID_HANDLE_VALUE || GetFileType(input) != FILE_TYPE_PIPE) return false;
    DWORD available = 0;
    if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) return true; // parent exited
    static std::string pending;
    if (available) {
        char bytes[256];
        DWORD got = 0;
        if (!ReadFile(input, bytes, std::min<DWORD>(available, sizeof(bytes)), &got, nullptr)) return true;
        pending.append(bytes, got);
    }
    return pending.find("stop") != std::string::npos;
}
class WaveFile {
    std::ofstream stream;
    uint32_t rate;
    uint16_t channels;
    uint32_t bytes = 0;
    void u16(uint16_t value) { stream.put(static_cast<char>(value)); stream.put(static_cast<char>(value >> 8)); }
    void u32(uint32_t value) { u16(static_cast<uint16_t>(value)); u16(static_cast<uint16_t>(value >> 16)); }
    void header() {
        stream.seekp(0);
        stream.write("RIFF", 4); u32(36 + bytes); stream.write("WAVEfmt ", 8);
        u32(16); u16(1); u16(channels); u32(rate); u32(rate * channels * 2);
        u16(channels * 2); u16(16); stream.write("data", 4); u32(bytes);
    }
public:
    WaveFile(const std::wstring& path, uint32_t sr, uint16_t ch) : rate(sr), channels(ch) {
        const std::filesystem::path target(path);
        if (std::filesystem::exists(target) && std::filesystem::file_size(target) != 0)
            throw std::runtime_error("refusing to overwrite non-empty output file");
        stream.open(target, std::ios::binary | std::ios::trunc);
        if (!stream) throw std::runtime_error("cannot create recording output");
        header();
    }
    void write(const BYTE* data, uint32_t length) {
        if (length > UINT32_MAX - bytes - 36) throw std::runtime_error("WAV size overflow");
        stream.write(reinterpret_cast<const char*>(data), length);
        if (!stream) throw std::runtime_error("recording disk write failed");
        bytes += length;
    }
    void finish() {
        header(); stream.flush();
        if (!stream) throw std::runtime_error("WAV header write failed");
        stream.close();
        if (stream.fail()) throw std::runtime_error("WAV close failed");
    }
};
struct BufferLock {
    IMFMediaBuffer* buffer;
    BYTE* data = nullptr;
    DWORD length = 0;
    explicit BufferLock(IMFMediaBuffer* value) : buffer(value) { check(buffer->Lock(&data, nullptr, &length), "IMFMediaBuffer::Lock"); }
    ~BufferLock() { buffer->Unlock(); }
};
static UINT32 get_u32(IMFMediaType* type, REFGUID key) {
    UINT32 value = 0; check(type->GetUINT32(key, &value), "read capture format"); return value;
}
static void validate_type(IMFSourceReader* reader, UINT32 sr, UINT32 channels) {
    ComPtr<IMFMediaType> actual;
    check(reader->GetCurrentMediaType(FIRST_AUDIO_STREAM, &actual), "GetCurrentMediaType");
    GUID subtype{};
    check(actual->GetGUID(MF_MT_SUBTYPE, &subtype), "read capture subtype");
    if (subtype != MFAudioFormat_PCM || get_u32(actual.Get(), MF_MT_AUDIO_BITS_PER_SAMPLE) != 16 ||
        get_u32(actual.Get(), MF_MT_AUDIO_SAMPLES_PER_SECOND) != sr ||
        get_u32(actual.Get(), MF_MT_AUDIO_NUM_CHANNELS) != channels ||
        get_u32(actual.Get(), MF_MT_AUDIO_BLOCK_ALIGNMENT) != channels * 2)
        throw std::runtime_error("Media Foundation returned an unexpected capture format");
}
static int capture(const std::wstring& id, const std::wstring& output, double seconds, UINT32 rate, UINT32 channels, bool streaming) {
    std::ostream& events = streaming ? std::cerr : std::cout;
    auto attrs = attributes();
    check(attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_GUID), "Set audio source type");
    if (!id.empty()) check(attrs->SetString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_ENDPOINT_ID, id.c_str()), "Set capture endpoint");
    Source source;
    check(MFCreateDeviceSource(attrs.Get(), &source.value), "MFCreateDeviceSource");
    ComPtr<IMFSourceReader> reader;
    check(MFCreateSourceReaderFromMediaSource(source.value.Get(), nullptr, &reader), "MFCreateSourceReaderFromMediaSource");
    ComPtr<IMFMediaType> type;
    check(MFCreateMediaType(&type), "MFCreateMediaType");
    check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio), "Set audio major type");
    check(type->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM), "Set PCM subtype");
    check(type->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16), "Set PCM bits");
    check(type->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate), "Set PCM rate");
    check(type->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, channels), "Set PCM channels");
    check(type->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, channels * 2), "Set PCM alignment");
    check(type->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * channels * 2), "Set PCM byte rate");
    check(type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE), "Set independent samples");
    check(reader->SetCurrentMediaType(FIRST_AUDIO_STREAM, nullptr, type.Get()), "SetCurrentMediaType PCM16");
    validate_type(reader.Get(), rate, channels);
    std::unique_ptr<WaveFile> file;
    if (streaming) {
        if (_setmode(_fileno(stdout), _O_BINARY) == -1) throw std::runtime_error("cannot set binary PCM output");
    } else file = std::make_unique<WaveFile>(output, rate, static_cast<uint16_t>(channels));
    const auto began = Clock::now();
    const uint64_t target = streaming && seconds == 0 ? UINT64_MAX : static_cast<uint64_t>(std::llround(seconds * rate));
    uint64_t frames = 0, clipped = 0, total_samples = 0;
    double energy = 0, peak = 0, last_report = -1;
    uint32_t ticks = 0, discontinuities = 0;
    events << "{\"type\":\"ready\",\"backend\":\"mediafoundation\",\"sampleRate\":" << rate << ",\"channels\":" << channels << ",\"bitsPerSample\":16}" << std::endl;
    while (frames < target && !stop_requested()) {
        ComPtr<IMFSample> sample;
        DWORD flags = 0;
        LONGLONG timestamp = 0;
        check(reader->ReadSample(FIRST_AUDIO_STREAM, 0, nullptr, &flags, &timestamp, &sample), "ReadSample");
        if (flags & MF_SOURCE_READERF_ERROR) throw std::runtime_error("source reader reported capture error");
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) throw std::runtime_error("microphone capture ended unexpectedly");
        if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) validate_type(reader.Get(), rate, channels);
        if (flags & MF_SOURCE_READERF_STREAMTICK) ++ticks;
        if (!sample) continue;
        UINT32 discontinuity = 0;
        if (SUCCEEDED(sample->GetUINT32(MFSampleExtension_Discontinuity, &discontinuity)) && discontinuity && frames) ++discontinuities;
        ComPtr<IMFMediaBuffer> buffer;
        check(sample->ConvertToContiguousBuffer(&buffer), "ConvertToContiguousBuffer");
        BufferLock locked(buffer.Get());
        const uint32_t alignment = channels * 2;
        if (locked.length % alignment) throw std::runtime_error("unaligned PCM capture buffer");
        const auto take = static_cast<uint32_t>(std::min<uint64_t>(locked.length / alignment, target - frames));
        if (!take) continue;
        if (streaming) {
            std::cout.write(reinterpret_cast<const char*>(locked.data), take * alignment);
            std::cout.flush();
            if (!std::cout) throw std::runtime_error("PCM consumer disconnected");
        } else file->write(locked.data, take * alignment);
        const auto pcm = reinterpret_cast<const int16_t*>(locked.data);
        double block_energy = 0;
        for (uint32_t i = 0; i < take * channels; ++i) {
            const double value = static_cast<double>(pcm[i]) / 32768.0;
            block_energy += value * value;
            peak = std::max(peak, std::abs(value));
            if (std::abs(value) > 0.99) ++clipped;
        }
        energy += block_energy;
        total_samples += static_cast<uint64_t>(take) * channels;
        frames += take;
        const double elapsed = std::chrono::duration<double>(Clock::now() - began).count();
        if (last_report < 0 || elapsed - last_report >= 0.4) {
            last_report = elapsed;
            events << "{\"type\":\"record_level\",\"level\":" << std::sqrt(block_energy / (take * channels))
                      << ",\"elapsed\":" << static_cast<double>(frames) / rate << ",\"duration\":" << seconds << "}" << std::endl;
        }
    }
    if (!frames && !streaming) throw std::runtime_error("recording stopped before any audio was captured");
    if (file) file->finish();
    reader.Reset(); // release reader before shutting down the capture source
    // A synchronous source reader can already have shut down the source on release.
    const HRESULT shutdown = source.value->Shutdown();
    if (shutdown != MF_E_SHUTDOWN) check(shutdown, "Media source shutdown");
    source.value.Reset();
    events << std::setprecision(10) << "{\"type\":\"complete\",\"ok\":true,\"backend\":\"mediafoundation\",\"sampleRate\":" << rate
              << ",\"channels\":" << channels << ",\"bitsPerSample\":16,\"frames\":" << frames
              << ",\"duration\":" << static_cast<double>(frames) / rate << ",\"peak\":" << peak
              << ",\"rms\":" << (total_samples ? std::sqrt(energy / total_samples) : 0) << ",\"clipped\":" << (total_samples ? 100.0 * clipped / total_samples : 0)
              << ",\"streamTicks\":" << ticks << ",\"discontinuities\":" << discontinuities << "}" << std::endl;
    return 0;
}
int wmain(int argc, wchar_t** argv) {
    bool streaming = false;
    try {
        bool list = false, duration_set = false;
        double seconds = 5;
        UINT32 rate = 44100, channels = 1;
        std::wstring id, output;
        for (int i = 1; i < argc; ++i) {
            const std::wstring key(argv[i]);
            if (key == L"--list") { list = true; continue; }
            if (key == L"--stream") { streaming = true; continue; }
            if (i + 1 >= argc) throw std::runtime_error("missing command argument");
            const std::wstring value(argv[++i]);
            if (key == L"--device") id = value;
            else if (key == L"--output") output = value;
            else if (key == L"--seconds") { seconds = std::stod(value); duration_set = true; }
            else if (key == L"--rate") rate = std::stoul(value);
            else if (key == L"--channels") channels = std::stoul(value);
            else throw std::runtime_error("unknown command argument");
        }
        if (streaming && !duration_set) seconds = 0;
        if ((list && streaming) || (!list && ((!streaming && output.empty()) || !std::isfinite(seconds) ||
                      seconds < 0 || (!streaming && seconds == 0) || seconds > 60 ||
                      rate < 8000 || rate > 192000 || channels < 1 || channels > 8 || (streaming && channels != 1))))
            throw std::runtime_error("invalid recording configuration");
        Runtime runtime;
        if (list) {
            std::cout << "{\"type\":\"devices\",\"backend\":\"mediafoundation\",\"inputs\":[";
            bool first = true;
            for (const auto& device : devices()) {
                if (!first) std::cout << ',';
                first = false;
                std::cout << "{\"name\":" << quote(utf8(device.name)) << ",\"id\":" << quote(utf8(device.id)) << ",\"default\":" << (device.is_default ? "true" : "false") << '}';
            }
            std::cout << "]}" << std::endl;
            return 0;
        }
        return capture(id, output, seconds, rate, channels, streaming);
    } catch (const std::exception& error) {
        (streaming ? std::cerr : std::cout) << "{\"type\":\"error\",\"ok\":false,\"detail\":" << quote(error.what()) << "}" << std::endl;
        return 1;
    }
}
