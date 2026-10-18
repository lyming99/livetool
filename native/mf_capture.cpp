// Windows audio capture helper: Media Foundation microphone input plus WASAPI
// loopback ("system sound" / computer output) capture. No PortAudio dependency.
// Microphone pipeline reference: record_windows 1.0.7, used by wenzflow's record 6.2.1.
// This standalone implementation uses Windows SDK interfaces; no Flutter code is linked.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <mmdeviceapi.h>
#include <propidl.h>
#include <audioclient.h>
#include <mmreg.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <wrl/client.h>
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

// Render (speaker) endpoints; these are the loopback capture sources.
// PKEY_Device_FriendlyName is declared locally to avoid an extra property-key header.
static const PROPERTYKEY kFriendlyNameKey = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}},
    14
};
static std::vector<Device> output_devices() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          IID_PPV_ARGS(&enumerator)), "Create audio endpoint enumerator");
    std::wstring default_id;
    ComPtr<IMMDevice> default_device;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &default_device))) {
        LPWSTR endpoint = nullptr;
        if (SUCCEEDED(default_device->GetId(&endpoint)) && endpoint != nullptr) {
            default_id = endpoint;
            CoTaskMemFree(endpoint);
        }
    }
    ComPtr<IMMDeviceCollection> collection;
    check(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection), "EnumAudioEndpoints");
    UINT32 count = 0;
    check(collection->GetCount(&count), "Get audio endpoint count");
    std::vector<Device> result;
    for (UINT32 i = 0; i < count; ++i) {
        ComPtr<IMMDevice> device;
        if (FAILED(collection->Item(i, &device))) continue;
        LPWSTR endpoint = nullptr;
        if (FAILED(device->GetId(&endpoint)) || endpoint == nullptr) continue;
        std::wstring name;
        ComPtr<IPropertyStore> store;
        if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store))) {
            PROPVARIANT value;
            PropVariantInit(&value);
            if (SUCCEEDED(store->GetValue(kFriendlyNameKey, &value)) && value.vt == VT_LPWSTR && value.pwszVal)
                name = value.pwszVal;
            PropVariantClear(&value);
        }
        if (name.empty()) name = L"\u626c\u58f0\u5668"; // "speaker", escaped to stay code-page independent
        std::wstring id(endpoint);
        CoTaskMemFree(endpoint);
        result.push_back({name, id, _wcsicmp(id.c_str(), default_id.c_str()) == 0});
    }
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

// WAVE_FORMAT_EXTENSIBLE sub-formats, declared locally so ksmedia.h is not required.
static const GUID kSubtypePcm = {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
static const GUID kSubtypeFloat = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

struct LoopbackFormat {
    UINT32 rate = 0;
    UINT16 channels = 0;
    UINT16 bits = 0;
    bool is_float = false;
};

// The render endpoint's shared-mode mix format decides how the stored samples are read.
static LoopbackFormat describe_loopback_format(const WAVEFORMATEX* format) {
    if (format == nullptr) throw std::runtime_error("loopback device reported no format");
    LoopbackFormat result;
    result.rate = format->nSamplesPerSec;
    result.channels = format->nChannels;
    result.bits = format->wBitsPerSample;
    if (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
        result.is_float = true;
    } else if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        if (format->cbSize < 22) throw std::runtime_error("unsupported loopback device format");
        const auto* extended = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
        if (IsEqualGUID(extended->SubFormat, kSubtypeFloat)) result.is_float = true;
        else if (!IsEqualGUID(extended->SubFormat, kSubtypePcm))
            throw std::runtime_error("unsupported loopback device format");
        if (extended->Samples.wValidBitsPerSample) result.bits = extended->Samples.wValidBitsPerSample;
    } else if (format->wFormatTag != WAVE_FORMAT_PCM) {
        throw std::runtime_error("unsupported loopback device format");
    }
    if (result.channels == 0 || result.channels > 8 || result.rate < 8000 || result.rate > 192000 ||
        !((result.is_float && result.bits == 32) || (!result.is_float && result.bits == 16)))
        throw std::runtime_error("unsupported loopback device format");
    return result;
}

// Mixes the render endpoint down to mono and converts to PCM16 at the requested rate.
// Callers publish each produced block; nothing grows into an intermediate file.
class LoopbackConverter {
    double ratio;
    std::vector<double> mono;
    std::vector<double> history;
    double position = 0;
public:
    LoopbackConverter(UINT32 source_rate, UINT32 target_rate)
        : ratio(static_cast<double>(source_rate) / static_cast<double>(target_rate)) {}
    void push(const BYTE* data, UINT32 frames, const LoopbackFormat& format, bool silent) {
        mono.clear();
        if (!frames) return;
        mono.reserve(frames);
        for (UINT32 i = 0; i < frames; ++i) {
            double value = 0;
            if (!silent && data != nullptr) {
                if (format.is_float) {
                    const auto* samples = reinterpret_cast<const float*>(data) + static_cast<size_t>(i) * format.channels;
                    for (UINT16 channel = 0; channel < format.channels; ++channel) value += samples[channel];
                } else {
                    const auto* samples = reinterpret_cast<const int16_t*>(data) + static_cast<size_t>(i) * format.channels;
                    for (UINT16 channel = 0; channel < format.channels; ++channel)
                        value += static_cast<double>(samples[channel]) / 32768.0;
                }
            }
            mono.push_back(value / static_cast<double>(format.channels));
        }
    }
    std::vector<int16_t> take() {
        std::vector<int16_t> out;
        if (mono.size()) {
            history.insert(history.end(), mono.begin(), mono.end());
            mono.clear();
        }
        while (position + 1.0 < static_cast<double>(history.size())) {
            const size_t index = static_cast<size_t>(position);
            const double fraction = position - static_cast<double>(index);
            const double value = history[index] + (history[index + 1] - history[index]) * fraction;
            const double clamped = std::max(-1.0, std::min(1.0, value));
            out.push_back(static_cast<int16_t>(std::lround(clamped * 32767.0)));
            position += ratio;
        }
        const size_t consumed = static_cast<size_t>(position);
        if (consumed) {
            history.erase(history.begin(), history.begin() + static_cast<std::ptrdiff_t>(consumed));
            position -= static_cast<double>(consumed);
        }
        return out;
    }
};

struct ScopedHandle {
    HANDLE value;
    explicit ScopedHandle(HANDLE handle) : value(handle) {}
    ~ScopedHandle() { if (value != nullptr) CloseHandle(value); }
    ScopedHandle(const ScopedHandle&) = delete;
    ScopedHandle& operator=(const ScopedHandle&) = delete;
};

// WASAPI loopback capture of a render endpoint ("computer sound").
static int capture_loopback(const std::wstring& id, const std::wstring& output, double seconds,
                            UINT32 rate, bool streaming) {
    std::ostream& events = streaming ? std::cerr : std::cout;
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)),
          "Create audio endpoint enumerator");
    ComPtr<IMMDevice> device;
    if (id.empty()) check(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device),
                          "GetDefaultAudioEndpoint (render)");
    else check(enumerator->GetDevice(id.c_str(), &device), "GetDevice (render)");
    ComPtr<IAudioClient> client;
    check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                           reinterpret_cast<void**>(client.GetAddressOf())), "Activate IAudioClient");
    WAVEFORMATEX* mix = nullptr;
    check(client->GetMixFormat(&mix), "GetMixFormat");
    std::unique_ptr<WAVEFORMATEX, decltype(&CoTaskMemFree)> format(mix, &CoTaskMemFree);
    const LoopbackFormat source = describe_loopback_format(mix);
    ScopedHandle ready(CreateEventW(nullptr, FALSE, FALSE, nullptr));
    if (ready.value == nullptr) throw std::runtime_error("cannot create loopback wake event");
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                             AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                             2000000, 0, mix, nullptr), "IAudioClient::Initialize loopback");
    check(client->SetEventHandle(ready.value), "SetEventHandle");
    ComPtr<IAudioCaptureClient> capture;
    check(client->GetService(IID_PPV_ARGS(&capture)), "GetService IAudioCaptureClient");
    LoopbackConverter converter(source.rate, rate);
    std::unique_ptr<WaveFile> file;
    if (streaming) {
        if (_setmode(_fileno(stdout), _O_BINARY) == -1) throw std::runtime_error("cannot set binary PCM output");
    } else file = std::make_unique<WaveFile>(output, rate, 1);
    const auto began = Clock::now();
    const uint64_t target = streaming && seconds == 0 ? UINT64_MAX : static_cast<uint64_t>(std::llround(seconds * rate));
    uint64_t frames = 0, clipped = 0, total_samples = 0;
    double energy = 0, peak = 0, last_report = -1;
    uint32_t discontinuities = 0;
    auto publish = [&](const std::vector<int16_t>& pcm) {
        if (pcm.empty() || frames >= target) return;
        const size_t take = static_cast<size_t>(std::min<uint64_t>(pcm.size(), target - frames));
        double block_energy = 0;
        for (size_t i = 0; i < take; ++i) {
            const double value = static_cast<double>(pcm[i]) / 32768.0;
            block_energy += value * value;
            peak = std::max(peak, std::abs(value));
            if (std::abs(value) > 0.99) ++clipped;
        }
        energy += block_energy;
        total_samples += take;
        frames += take;
        if (streaming) {
            std::cout.write(reinterpret_cast<const char*>(pcm.data()),
                            static_cast<std::streamsize>(take * sizeof(int16_t)));
            std::cout.flush();
            if (!std::cout) throw std::runtime_error("PCM consumer disconnected");
        } else {
            file->write(reinterpret_cast<const BYTE*>(pcm.data()), static_cast<uint32_t>(take * sizeof(int16_t)));
        }
        const double elapsed = std::chrono::duration<double>(Clock::now() - began).count();
        if (last_report < 0 || elapsed - last_report >= 0.4) {
            last_report = elapsed;
            events << "{\"type\":\"record_level\",\"level\":" << std::sqrt(block_energy / take)
                   << ",\"elapsed\":" << static_cast<double>(frames) / rate
                   << ",\"duration\":" << seconds << "}" << std::endl;
        }
    };
    events << "{\"type\":\"ready\",\"backend\":\"wasapi-loopback\",\"sampleRate\":" << rate
           << ",\"channels\":1,\"bitsPerSample\":16,\"sourceRate\":" << source.rate
           << ",\"sourceChannels\":" << source.channels << "}" << std::endl;
    check(client->Start(), "IAudioClient::Start");
    while (frames < target && !stop_requested()) {
        const DWORD waited = WaitForSingleObject(ready.value, 100);
        if (waited == WAIT_FAILED) throw std::runtime_error("waiting for loopback audio failed");
        if (waited != WAIT_OBJECT_0) continue;
        UINT32 packet = 0;
        while (frames < target && SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet) {
            BYTE* data = nullptr;
            UINT32 available = 0;
            DWORD flags = 0;
            check(capture->GetBuffer(&data, &available, &flags, nullptr, nullptr), "IAudioCaptureClient::GetBuffer");
            if (available) {
                if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) && frames) ++discontinuities;
                converter.push(data, available, source, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
                publish(converter.take());
            }
            check(capture->ReleaseBuffer(available), "IAudioCaptureClient::ReleaseBuffer");
            if (stop_requested()) break;
        }
    }
    client->Stop();
    if (!frames && !streaming) throw std::runtime_error("recording stopped before any audio was captured");
    if (file) file->finish();
    capture.Reset();
    client.Reset();
    device.Reset();
    events << std::setprecision(10) << "{\"type\":\"complete\",\"ok\":true,\"backend\":\"wasapi-loopback\""
              ",\"sampleRate\":" << rate << ",\"channels\":1,\"bitsPerSample\":16,\"frames\":" << frames
           << ",\"duration\":" << static_cast<double>(frames) / rate << ",\"peak\":" << peak
           << ",\"rms\":" << (total_samples ? std::sqrt(energy / total_samples) : 0)
           << ",\"clipped\":" << (total_samples ? 100.0 * clipped / total_samples : 0)
           << ",\"streamTicks\":0,\"discontinuities\":" << discontinuities
           << ",\"sourceRate\":" << source.rate << ",\"sourceChannels\":" << source.channels << "}" << std::endl;
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    bool streaming = false;
    try {
        bool list = false, list_output = false, loopback = false, duration_set = false;
        double seconds = 5;
        UINT32 rate = 44100, channels = 1;
        std::wstring id, output;
        for (int i = 1; i < argc; ++i) {
            const std::wstring key(argv[i]);
            if (key == L"--list") { list = true; continue; }
            if (key == L"--list-output") { list_output = true; continue; }
            if (key == L"--loopback") { loopback = true; continue; }
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
        const bool listing = list || list_output;
        if ((listing && streaming) || (!listing && ((!streaming && output.empty()) || !std::isfinite(seconds) ||
                      seconds < 0 || (!streaming && seconds == 0) || seconds > 60 ||
                      rate < 8000 || rate > 192000 || channels < 1 || channels > 8 ||
                      (streaming && channels != 1) || (loopback && channels != 1))))
            throw std::runtime_error("invalid recording configuration");
        Runtime runtime;
        if (list || list_output) {
            std::cout << "{\"type\":\"devices\",\"backend\":\"mediafoundation\"";
            std::cout << (list ? ",\"kind\":\"input\",\"inputs\":[" : ",\"kind\":\"output\",\"outputs\":[");
            bool first = true;
            for (const auto& device : (list ? devices() : output_devices())) {
                if (!first) std::cout << ',';
                first = false;
                std::cout << "{\"name\":" << quote(utf8(device.name)) << ",\"id\":" << quote(utf8(device.id))
                          << ",\"default\":" << (device.is_default ? "true" : "false") << '}';
            }
            std::cout << "]}" << std::endl;
            return 0;
        }
        if (loopback) return capture_loopback(id, output, seconds, rate, streaming);
        return capture(id, output, seconds, rate, channels, streaming);
    } catch (const std::exception& error) {
        (streaming ? std::cerr : std::cout) << "{\"type\":\"error\",\"ok\":false,\"detail\":" << quote(error.what()) << "}" << std::endl;
        return 1;
    }
}
